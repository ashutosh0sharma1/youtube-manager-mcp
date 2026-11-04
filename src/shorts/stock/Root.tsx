import React from 'react';
import {AbsoluteFill,Composition,Img,staticFile} from 'remotion';
type Props={layer:'art'|'overlay';image:string;fontFile:string;variant:number;scene:number;sceneCount:number;hi:string;en:string;lyric:string;meaningHi:string;meaningEn:string;artLabel:string;topic:string;mode:string;progress:number};
const palettes=[['#102d2d','#f9efdc','#d9b578'],['#2a1726','#fff0df','#efb6a5'],['#17283b','#f3eedf','#d9c494'],['#382619','#fbf0dc','#c9d4ad']];
export const StockScene:React.FC<Props>=p=>{
 const [bg,ink,accent]=palettes[p.variant%4];
 const split=p.variant%4===2,frame=p.variant%4===1;const artTop=split?390:340;const artHeight=split?690:760;
 if(p.layer==='art')return <AbsoluteFill style={{backgroundColor:bg}}><Img src={staticFile(p.image)} style={{position:'absolute',inset:-70,width:1220,height:2060,objectFit:'cover',filter:'blur(45px)',opacity:.13}}/><div style={{position:'absolute',left:frame?92:62,right:frame?148:118,top:artTop,height:artHeight,border:frame?`2px solid ${accent}66`:'none',padding:frame?18:0}}><Img src={staticFile(p.image)} style={{width:'100%',height:'100%',objectFit:'contain'}}/></div></AbsoluteFill>;
 return <AbsoluteFill style={{color:ink,fontFamily:'SBSStock, sans-serif'}}><style>{`@font-face{font-family:SBSStock;src:url('${staticFile(p.fontFile)}')}*{box-sizing:border-box}`}</style>
  <div style={{position:'absolute',left:68,top:84,fontSize:23,letterSpacing:4,color:accent}}>SHIVALA BHAKTI SAGAR</div>
  <div style={{position:'absolute',left:68,right:155,top:137,height:174}}><div style={{fontSize:p.hi.length>55?43:49,fontWeight:700,lineHeight:1.38}}>{p.hi}</div><div style={{fontSize:p.en.length>80?26:29,lineHeight:1.35,marginTop:13,color:ink+'dd'}}>{p.en}</div></div>
  <div style={{position:'absolute',left:68,right:155,top:1115,fontSize:20,lineHeight:1.4,color:accent}}>{p.artLabel}</div>
  <div style={{position:'absolute',left:68,right:155,top:1180,borderTop:`1px solid ${accent}88`,paddingTop:22}}>
   <div style={{fontSize:20,letterSpacing:2,color:accent}}>श्रवण पाठ · SUNG WORDS</div>
   <div style={{fontSize:p.lyric.length>85?36:43,fontWeight:600,lineHeight:1.6,marginTop:16,minHeight:140,whiteSpace:'pre-line'}}>{p.lyric||'♪'}</div>
  </div>
  <div style={{position:'absolute',left:68,right:155,top:1470,paddingTop:16,borderTop:`1px solid ${accent}55`}}><div style={{fontSize:19,color:accent,letterSpacing:1.4}}>{p.mode}</div><div style={{fontSize:32,lineHeight:1.5,marginTop:14}}>{p.meaningHi}</div><div style={{fontSize:25,lineHeight:1.4,marginTop:12,color:ink+'dd'}}>{p.meaningEn}</div></div>
  <div style={{position:'absolute',left:68,right:155,top:1740,display:'flex',justifyContent:'space-between',alignItems:'center',color:accent,fontSize:20}}><span>{p.topic}</span><span>{String(p.scene+1).padStart(2,'0')} / {String(p.sceneCount).padStart(2,'0')}</span></div>
  <div style={{position:'absolute',left:68,right:155,top:1790,height:3,background:accent+'33'}}><div style={{height:3,width:Math.max(5,p.progress*100)+'%',background:accent}}/></div>
 </AbsoluteFill>;
};
export const StockRoot=()=> <Composition id="SBSStockScene" component={StockScene as React.FC<any>} width={1080} height={1920} fps={30} durationInFrames={1}/>;
