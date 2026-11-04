import test from 'node:test';
import assert from 'node:assert/strict';
import {rankCandidates} from '../scripts/shorts/ranking.mjs';
import {estimateCost,reportedCost} from '../scripts/shorts/openrouter.mjs';
import {validatePlan,channelId} from '../scripts/shorts/lib.mjs';
test('ranking deduplicates sources and marks low-exposure evidence exploratory',()=>{
 const metadata=[{id:'a',privacy:'public',duration:30},{id:'a',privacy:'public',duration:30},{id:'b',privacy:'public',duration:40},{id:'private',privacy:'private',duration:20}];
 const ranked=rankCandidates(metadata,{recent:[{video:'a',views:1000,engagedViews:500,shares:10,subscribersGained:2},{video:'b',views:2,engagedViews:1,shares:1,subscribersGained:0}],previous:[],long:[]});
 assert.equal(ranked.length,2);assert.equal(ranked.find(x=>x.id==='a').evidenceStrength,'strong');assert.equal(ranked.find(x=>x.id==='b').evidenceStrength,'exploratory');assert.ok(ranked.every(x=>Number.isFinite(x.rankScore)));assert.ok(ranked.every(x=>!('viralProbability' in x)));
});
test('paid-call estimator rejects unknown or invalid prices and accounts for output cap',()=>{
 assert.throws(()=>estimateCost({prompt:'bad',completion:'0.1'},'x',10));assert.throws(()=>estimateCost({prompt:'-1',completion:'0.1'},'x',10));
 const low=estimateCost({prompt:'0.000001',completion:'0.000002'},'x',100);const high=estimateCost({prompt:'0.000001',completion:'0.000002'},'x',1000);assert.ok(high>low);assert.ok(high>=1000*0.000002);
 assert.throws(()=>estimateCost({prompt:'0.000001',completion:'0.000002'},'x',Infinity));assert.equal(reportedCost(-1),null);assert.equal(reportedCost(NaN),null);assert.equal(reportedCost(0),0);
});
test('plan validation prevents source path traversal, duplicate outputs and inverted audio ranges',()=>{
 const clip={id:'01-shiva',sourceId:'ThgrJZZ3-gU',hook:['शिव के नाम','भाव से सुनें'],audioStart:0,audioEnd:30};
 const valid={channelId,clips:[clip]};assert.equal(validatePlan(valid),valid);
 assert.throws(()=>validatePlan({channelId,clips:[{...clip,sourceId:'../../secret'}]}));
 assert.throws(()=>validatePlan({channelId,clips:[clip,clip]}));
 assert.throws(()=>validatePlan({channelId,clips:[{...clip,audioStart:40}]}));
});
