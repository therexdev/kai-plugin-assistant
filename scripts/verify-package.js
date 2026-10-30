"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => JSON.stringify(k)+":"+canonical(value[k])).join(",")}}`; return JSON.stringify(value); }
const root = path.join(__dirname,".."), source=path.join(root,"plugin"), manifest=JSON.parse(fs.readFileSync(path.join(source,"manifest.json"),"utf8")), meta=JSON.parse(fs.readFileSync(path.join(root,"publisher.json"),"utf8"));
const name=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8")).name;
const file=path.join(root,"dist",`${name}-${manifest.version}.kaiplugin`), pkg=JSON.parse(fs.readFileSync(file,"utf8"));
assert.deepEqual(Object.keys(pkg).sort(),["files","manifest","publicKey","signature"]);
assert.deepEqual(pkg.manifest,manifest); assert.equal(manifest.id,meta.id); assert.equal(pkg.publicKey,meta.publicKey);
const key=crypto.createPublicKey({key:Buffer.from(pkg.publicKey,"base64"),format:"der",type:"spki"});
assert.equal(key.asymmetricKeyType,"ed25519"); assert.equal(crypto.createHash("sha256").update(key.export({format:"der",type:"spki"})).digest("hex"),meta.fingerprint);
assert.ok(crypto.verify(null,Buffer.from(canonical({manifest:pkg.manifest,files:pkg.files})),key,Buffer.from(pkg.signature,"base64")),"Publisher signature does not match");
const files={}; function walk(dir,prefix=""){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const rel=prefix+item.name;if(rel==="manifest.json")continue;assert.ok(!item.isSymbolicLink(),"No symlinks"); if(item.isDirectory())walk(path.join(dir,item.name),rel+"/");else files[rel]=fs.readFileSync(path.join(dir,item.name)).toString(/\.(png|jpg|jpeg|webp|gif|wav|ogg|mp3|woff2?)$/i.test(rel)?"base64":"utf8");}} walk(source);
assert.deepEqual(pkg.files,files,"Signed release differs from checked-in plugin source"); assert.ok(Buffer.byteLength(JSON.stringify(pkg))<=24*1024*1024);
assert.equal(manifest.version,JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8")).version);
console.log(`Verified ${manifest.id}@${manifest.version}, ${Object.keys(files).length} signed source files.`);
