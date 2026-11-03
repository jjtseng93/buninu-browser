// Decoder names from the bundled @wasmpeg/cpu 1.0.1 LGPL preset.
// Source: vendor/wasmpeg/source-v1.0.1.tar.gz, src/cli/configure.mjs.
// COMPAT.md distinguishes enabled codecs from sample-level correctness.
// FFmpeg's built-in AV1 entry needs hardware; this CPU build has no dav1d/aom.
const video = new Set(`
h264 hevc vp8 vp9 mpeg1video mpeg2video mpeg4 h263 h261 msmpeg4v1 msmpeg4v2 msmpeg4v3 wmv1 wmv2 wmv3 vc1 mss2
prores qtrle svq1 svq3 dnxhd mjpeg mjpegb cfhd huffyuv ffv1 ffvhuff utvideo magicyuv lagarith hap bink theora
vp3 vp6 vp6a vp6f vp7 rv10 rv20 rv30 rv40 flashsv flashsv2 cinepak msvideo1 fraps cdxl flic zmbv cllc hq_hqa
hqx speedhq indeo2 indeo3 indeo4 indeo5 loco msrle dvvideo dxtory fic fmvc frwu mszh zlib lscr rscc tscc tscc2
vble zerocodec mwsc screenpresso g2meet mss1 lead dxv aic aura aura2 cljr cyuv ulti vcr1 xl wnv1 vqc
truemotion1 truemotion2 truemotion2rt xan_wc3 xan_wc4 vp4 vp5 mimic mdec eamad eatgq sgirle nuv rv60 thp txd
mts2 avui avrn cavs roqvideo dirac dfa brender_pix paf_video vmdvideo fits fourxm jv vb ansi dxa aasc qpeg
sp5x motionpixels mvc1 mvc2 rl2 c93 cdgraphics bethsoftvid bfi tmv tdsc cscd kmvc qdraw smc rpza pixlet idcin
dsicinvideo smacker bmv_video r210 v210 v410 r10k png apng gif bmp tiff webp targa dpx xbm sunrast xface
jpeg2000 jpegls exr psd
`.trim().split(/\s+/));
const audio = new Set(`
aac aac_latm opus mp3 mp2 mp1 vorbis flac ac3 ac3_fixed eac3 dca truehd mlp alac wavpack ape tta shorten wmav1
wmav2 wmapro wmalossless wmavoice pcm_s8 pcm_u8 pcm_s16le pcm_s16be pcm_u16le pcm_u16be pcm_s24le pcm_s24be
pcm_u24le pcm_u24be pcm_s32le pcm_s32be pcm_u32le pcm_u32be pcm_f32le pcm_f32be pcm_f64le pcm_f64be pcm_mulaw
pcm_alaw pcm_dvd pcm_bluray pcm_vidc adpcm_ms adpcm_ima_wav adpcm_ima_qt adpcm_swf adpcm_yamaha adpcm_thp
adpcm_g726 adpcm_g726le adpcm_g722 adpcm_4xm adpcm_afc adpcm_dtk adpcm_ea adpcm_ea_maxis_xa adpcm_ea_r1
adpcm_ea_r2 adpcm_ea_r3 adpcm_ima_amv adpcm_ima_apc adpcm_ima_dk3 adpcm_ima_dk4 adpcm_ima_ea_eacs
adpcm_ima_ea_sead adpcm_ima_iss adpcm_ima_oki adpcm_ima_rad adpcm_ima_smjpeg adpcm_ima_ws adpcm_argo
adpcm_sanyo adpcm_vima adpcm_xa adpcm_sbpro_2 adpcm_sbpro_3 adpcm_sbpro_4 roq_dpcm interplay_dpcm sol_dpcm
xan_dpcm speex nellymoser amrnb amrwb g722 g723_1 g726 gsm gsm_ms atrac1 atrac3 atrac3p sipr imc truespeech
cook ra_144 ra_288 qcelp g728 twinvq dolby_e dst mpc7 mpc8 mace3 mace6 escape124 escape130 qoa tak smackaud
paf_audio vmdaudio bmv_audio dsicinaudio dss_sp msnsiren dsd_lsbf dsd_msbf qdm2 binkaudio_dct binkaudio_rdft
`.trim().split(/\s+/));

// Browser/RFC 6381 codec identifiers -> FFmpeg's software decoder names.
const aliases={
 avc1:'h264',avc3:'h264',hvc1:'hevc',hev1:'hevc',vp08:'vp8',vp09:'vp9',mp4v:'mpeg4',
 'ac-3':'ac3','ec-3':'eac3',dtsc:'dca',dtse:'dca',dtsh:'dca',dtsl:'dca',
 '1':'pcm_s16le','3':'pcm_f32le','6':'pcm_alaw','7':'pcm_mulaw',
 apch:'prores',apcn:'prores',apcs:'prores',apco:'prores',ap4h:'prores',ap4x:'prores',
 samr:'amrnb',sawb:'amrwb',s263:'h263',jpeg:'mjpeg',
};
export function softwareCodec(token) {
 const parts=String(token).toLowerCase().split('.'),family=parts[0];
 let decoder=aliases[family]||family;
 if(family==='mp4a'){
  const object=parts[1];
  decoder=!object||['40','66','67','68'].includes(object)?'aac':['69','6b'].includes(object)?'mp3':null;
 }
 return decoder&&(video.has(decoder)||audio.has(decoder))?decoder:null;
}

// A container being recognised does not imply that every codec fits in it.
const mp4Video='h264 hevc mpeg4 h263 vp9 mjpeg prores',mp4Audio='aac mp3 ac3 eac3 alac flac opus dca truehd mlp';
const webmVideo='vp8 vp9',webmAudio='opus vorbis';
const containers=new Map();
const register=(types,kind,codecs=null)=>{
 const entry={kind,codecs:codecs?new Set(codecs.split(/\s+/)):null};
 for(const type of types.split(/\s+/))containers.set(type,entry);
};
register('video/mp4 video/x-m4v video/3gpp video/3gpp2','video',mp4Video+' '+mp4Audio);
register('audio/mp4 audio/x-m4a audio/m4a','audio',mp4Audio);
register('video/webm','video',webmVideo+' '+webmAudio);
register('audio/webm','audio',webmAudio);
register('video/quicktime video/x-matroska video/matroska video/x-msvideo video/avi video/msvideo video/x-ms-wmv video/x-ms-asf application/vnd.ms-asf video/x-flv video/flv video/vnd.rn-realvideo application/vnd.rn-realmedia application/mxf video/mxf video/dv video/bink video/x-bink','video');
register('audio/x-matroska audio/x-ms-wma audio/x-ms-asf audio/x-pn-realaudio audio/vnd.rn-realaudio','audio');
register('video/mpeg video/mp2t','video','mpeg1video mpeg2video mpeg4 h264 hevc mp1 mp2 mp3 aac aac_latm ac3 eac3 dca truehd pcm_dvd pcm_bluray');
register('video/ogg application/ogg','video','theora vp3 dirac flac vorbis opus speex');
register('audio/ogg','audio','vorbis opus flac speex');
register('audio/mpeg audio/mp3 audio/mpeg3 audio/x-mpeg3','audio','mp1 mp2 mp3');
register('audio/aac audio/x-aac audio/aacp','audio','aac aac_latm');
register('audio/wav audio/wave audio/x-wav audio/vnd.wave','audio');
for(const [types,codecs] of [
 ['video/h264 video/x-h264','h264'],['video/hevc video/h265 video/x-hevc','hevc'],
 ['video/x-msvc1','vc1'],['audio/flac audio/x-flac','flac'],
 ['audio/ac3 audio/ac-3','ac3 ac3_fixed'],['audio/eac3 audio/ec-3','eac3'],
 ['audio/dts audio/vnd.dts','dca'],['audio/true-hd audio/x-true-hd','truehd'],['audio/x-mlp','mlp'],
 ['audio/amr','amrnb'],['audio/amr-wb','amrwb'],['audio/opus','opus'],['audio/vorbis','vorbis'],
 ['audio/speex audio/x-speex','speex'],['audio/wavpack audio/x-wavpack','wavpack'],
 ['audio/ape audio/x-ape','ape'],['audio/tta audio/x-tta','tta'],
 ['audio/x-shorten audio/x-shortened','shorten'],['audio/x-musepack audio/musepack','mpc7 mpc8'],
 ['audio/gsm audio/x-gsm','gsm gsm_ms'],['audio/g722','g722'],['audio/g723','g723_1'],
 ['audio/g726','adpcm_g726 adpcm_g726le'],['audio/g728','g728'],
 ['audio/qcp audio/vnd.qcelp','qcelp'],['audio/atrac3 audio/vnd.sony.atrac3','atrac3 atrac3p'],
])register(types,types.startsWith('video/')?'video':'audio',codecs);

/** File playback capability; MSE has its own narrower append-container policy. */
export function mediaFileTypeSupported(type) {
 const value=String(type).trim().toLowerCase();
 if(/[\u0000\r\n]/.test(value))return false;
 const parts=value.split(';').map(part=>part.trim()),entry=containers.get(parts.shift());
 if(!entry)return false;
 const parameter=parts.find(part=>/^codecs\s*=/.test(part));
 if(!parameter)return true;
 const match=/^codecs\s*=\s*(?:"([^"]*)"|([^"\s]+))$/.exec(parameter);
 if(!match)return false;
 const codecs=(match[1]??match[2]).split(',').map(token=>token.trim());
 if(!codecs.length||codecs.some(token=>!token))return false;
 return codecs.every(token=>{
  const decoder=softwareCodec(token);
  return decoder&&(entry.kind==='video'||audio.has(decoder))&&(!entry.codecs||entry.codecs.has(decoder));
 });
}
