import * as acorn from 'acorn';
import { visit } from '../lib/ast.mjs';
import { replaceOnce } from '../lib/anchor.mjs';

export const recovery = `globalThis.__cxpManagedLogin=async(_client,_params)=>{
try{return await _client.sendRequest('account/login/start',_params)}catch(_error){
if(!String(_error?.message??_error).includes('External auth is active.'))throw _error;
await _client.sendRequest('account/logout',{});
return _client.sendRequest('account/login/start',_params);
}};`;

export default {
  id: '071-auth-lifecycle',
  description: 'Preserve managed native auth on startup and recover explicit sign-in from external auth',
  glob: 'webview/assets/app-*.js',
  select: 'globalThis.__cxpRestore=',
  marker: 'globalThis.__cxpManagedLogin=',
  apply(source) {
    // getAccount waits for restore, so use the underlying request directly.
    // Only skip restoration after confirming the native disk session is loaded.
    source = replaceOnce(source, 'if(!_want)return;', `if(!_want)return;
const _native=_view.accounts?.find(_a=>_a.id===_want&&_a.native);
if(_native){try{const _loaded=await _client.sendRequest('account/read',{refreshToken:false});
if(_loaded?.account?.type==='chatgpt'&&_native.email&&_loaded.account.email===_native.email){globalThis.__cxpConfirmedAccountId=_want;return}}catch{}}
`);
    const edits=[];
    visit(acorn.parse(source,{ecmaVersion:'latest',sourceType:'module'}),node=>{
      if(node.type!=='CallExpression'||node.callee.type!=='MemberExpression'||node.callee.property.name!=='sendRequest')return;
      const [method,params]=node.arguments;
      const value=method?.type==='TemplateLiteral'?method.quasis[0]?.value.raw:method?.value;
      if(value!=='account/login/start'||params?.type!=='ObjectExpression')return;
      const type=params.properties.find(p=>p.key?.name==='type')?.value;
      const mode=type?.type==='TemplateLiteral'?type.quasis[0]?.value.raw:type?.value;
      if(!['chatgpt','chatgptDeviceCode','apiKey'].includes(mode))return;
      edits.push({start:node.start,end:node.end,text:`globalThis.__cxpManagedLogin(${source.slice(node.callee.object.start,node.callee.object.end)},${source.slice(params.start,params.end)})`});
    });
    if(edits.length!==3)throw Error(`Expected three managed login requests, found ${edits.length}`);
    for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
    return recovery+'\n'+source;
  }
};
