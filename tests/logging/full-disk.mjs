import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, open, readFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { LogFileSink } from "../../packages/utils/dist/log-file-sink.js";

if(process.argv[2]!=="inside"){
	const output=execFileSync("unshare",["--user","--map-root-user","--mount",process.execPath,import.meta.filename,"inside"],{encoding:"utf8",timeout:15000});
	process.stdout.write(output);
}else{
	const directory=await mkdtemp(join(tmpdir(),"logging-full-disk-"));
	execFileSync("mount",["-t","tmpfs","-o","size=1m,mode=0700","logging-test",directory]);
	const destination=join(directory,"ordinary.log");
	const notices=[];
	const sink=new LogFileSink(destination,(reason,fields)=>{notices.push({reason,fields});return JSON.stringify({reason,fields});});
	sink.enqueue(JSON.stringify({before:true}),"info");
	await sink.close();
	const filler=await open(join(directory,"fill"),"w");
	let code;
	try{for(let index=0;index<512;index++)await filler.write(Buffer.alloc(4096));}catch(error){code=error.code;}finally{await filler.close();}
	assert.equal(code,"ENOSPC","isolated kernel filesystem is actually full");
	const failing=new LogFileSink(destination,(reason,fields)=>{notices.push({reason,fields});return JSON.stringify({reason,fields});});
	for(let index=0;index<20;index++)failing.enqueue(JSON.stringify({index,padding:"x".repeat(8192)}),"error");
	const start=performance.now();
	await failing.close();
	assert.ok(performance.now()-start<2500);
	assert.equal(failing.status().reason,"file_sink_failed");
	assert.equal(notices.filter(row=>row.reason==="file_sink_failed").length,1);
	assert.ok((await readFile(destination,"utf8")).startsWith('{"before":true}\n'));
	console.log(JSON.stringify({passed:true,host:hostname(),directory,kernel_error:code,checks:5}));
}
