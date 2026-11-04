export function rankCandidates(metadata,reports){
 const maps=Object.fromEntries(Object.entries(reports).map(([k,rows])=>[k,new Map(rows.map(x=>[x.video,x]))]));
 const empty={views:0,engagedViews:0,shares:0,subscribersGained:0,averageViewPercentage:0};
 const unique=[...new Map(metadata.map(v=>[v.id,v])).values()];
 const candidates=unique.filter(v=>v.privacy==='public'&&v.duration>=10&&v.duration<=120).map(v=>({...v,recent:{...empty,...maps.recent.get(v.id)},previous:{...empty,...maps.previous.get(v.id)},long:{...empty,...maps.long.get(v.id)}}));
 const totalEngaged=candidates.reduce((n,x)=>n+x.recent.engagedViews,0);
 const sharePrior=candidates.reduce((n,x)=>n+x.recent.shares,0)/Math.max(1,totalEngaged);
 const subPrior=candidates.reduce((n,x)=>n+x.recent.subscribersGained,0)/Math.max(1,totalEngaged);
 for(const x of candidates){const e=x.recent.engagedViews;x.features={demand:Math.log1p(e/28),shares:(x.recent.shares+500*sharePrior)/(e+500),subscribers:(x.recent.subscribersGained+500*subPrior)/(e+500),momentum:Math.log((e+50)/(x.previous.engagedViews+50)),durable:Math.log1p(x.long.engagedViews/90)};}
 const weights={demand:0.5,shares:0.20,subscribers:0.10,momentum:0.05,durable:0.15};
 const percentile=(key,value)=>candidates.length<=1?0.5:candidates.filter(x=>x.features[key]<value).length/(candidates.length-1);
 for(const x of candidates){x.rankScore=Number((100*Object.entries(weights).reduce((n,[key,w])=>n+w*percentile(key,x.features[key]),0)).toFixed(2));x.evidenceStrength=x.recent.engagedViews>=300?'strong':x.recent.engagedViews>=100?'moderate':'exploratory';}
 return candidates.sort((a,b)=>b.rankScore-a.rankScore).map((x,i)=>({...x,evidenceRank:i+1,weights,sharePrior,subPrior}));
}
