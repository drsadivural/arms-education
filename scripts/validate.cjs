const fs=require('fs');const path=require('path');const parser=require('@apidevtools/swagger-parser');
const root=path.resolve(__dirname,'..');
(async()=>{
 const contract=await parser.validate(path.join(root,'contracts/openapi.json'));
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'design/manifest.json')));
 for(const s of manifest){if(!fs.existsSync(path.join(root,s.path)))throw Error('Missing screen '+s.path);}
 const tools=JSON.parse(fs.readFileSync(path.join(root,'contracts/voice-tools.json'))).tools;
 for(const t of tools){if(!t.name||t.parameters.additionalProperties!==false)throw Error('Unsafe tool schema');}
 const report={openapi_valid:true,operations:Object.values(contract.paths).reduce((n,x)=>n+Object.keys(x).length,0),schemas:Object.keys(contract.components.schemas).length,pngs:manifest.length,voice_tools:tools.length};
 fs.writeFileSync(path.join(root,'verification/contract-checks.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.message);process.exit(1)});
