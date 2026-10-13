const fs=require('node:fs');
module.exports=function switchLearning(file,clock=Date.now){
 const pending=new Map();
 function samples(){try{const v=JSON.parse(fs.readFileSync(file,'utf8'));return Array.isArray(v)?v.filter(n=>Number.isFinite(n)&&n>=0&&n<=2).slice(-20):[]}catch{return []}}
 return {
  begin(id,current){if(id!==current)pending.set(id,clock())},
  end(id){const start=pending.get(id);pending.delete(id);if(start===undefined)return;const duration=(clock()-start)/60000;if(!Number.isFinite(duration)||duration<0||duration>2)return;const values=[...samples(),duration].slice(-20),temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(values),{mode:0o600});fs.renameSync(temp,file)},
  minutes(){const values=samples().sort((a,b)=>a-b);return values.length?values[Math.floor((values.length-1)*0.8)]:2}
 };
};
