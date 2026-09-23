import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const exists = (p) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };
import { lstatSync } from 'node:fs';

export class IsolationUnavailableError extends Error { constructor(message) { super(message); this.name='IsolationUnavailableError'; } }

export function probeBubblewrap(bwrapPath='bwrap') {
  const probe = spawnSync(bwrapPath,['--die-with-parent','--unshare-user','--unshare-pid','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--proc','/proc','--dev','/dev','/usr/bin/true'],{encoding:'utf8',timeout:3000});
  return {available:probe.status===0,path:bwrapPath,error:probe.status===0?null:(probe.stderr||probe.error?.message||`exit ${probe.status}`).trim()};
}

async function regularFile(path) { const st=await lstat(path); if(!st.isFile()||st.isSymbolicLink()) throw new IsolationUnavailableError(`Refusing non-regular credential input: ${path}`); return st; }

export async function preparePrivateCodexHome({ sourceHome=process.env.CODEX_HOME??join(homedir(),'.codex'), sessionDir, bwrapPath='bwrap', requireBubblewrap=true }={}) {
  if(!sessionDir) throw new TypeError('sessionDir is required');
  const probe=requireBubblewrap?probeBubblewrap(bwrapPath):{available:true,path:bwrapPath,error:null}; if(!probe.available) throw new IsolationUnavailableError(`Bubblewrap isolation is unavailable: ${probe.error}`);
  const root=resolve(sessionDir), home=join(root,'codex-home');
  await mkdir(root,{recursive:true,mode:0o700}); await chmod(root,0o700); await mkdir(home,{recursive:true,mode:0o700}); await chmod(home,0o700);
  await regularFile(join(sourceHome,'auth.json'));
  await copyFile(join(sourceHome,'auth.json'),join(home,'auth.json')); await chmod(join(home,'auth.json'),0o600);
  for(const name of ['models_cache.json','installation_id']) { try { await regularFile(join(sourceHome,name)); await copyFile(join(sourceHome,name),join(home,name)); await chmod(join(home,name),0o600); } catch(error) { if(error.code!=='ENOENT') throw error; } }
  for(const name of ['sessions','logs','cache','tmp']) await mkdir(join(home,name),{recursive:true,mode:0o700});
  return {root,home,profile:'bwrap-v1',bwrapPath,probe};
}

function mountDir(args,path) { args.push('--dir',path); }

export function buildBubblewrapInvocation({bwrapPath='bwrap',workspaceDir,sessionStateDir,codexHome,skillsDir,codexPath='codex',argv=[]}) {
  const workspace=resolve(workspaceDir), state=resolve(sessionStateDir), privateHome=resolve(codexHome);
  const user=process.env.USER??'codex';
  const nodeBin=dirname(process.execPath); const nodePrefix=dirname(nodeBin);
  const args=['--die-with-parent','--unshare-user','--unshare-pid','--share-net','--cap-drop','ALL',
    '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
    '--proc','/proc','--dev','/dev','--tmpfs','/tmp'];
  for(const file of ['/etc/ssl/certs','/etc/ca-certificates','/etc/pki/ca-trust','/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf','/etc/passwd','/etc/group','/etc/localtime']) {
    try { lstatSync(file); args.push('--ro-bind',file,file); } catch {}
  }
  mountDir(args,'/home'); mountDir(args,`/home/${user}`); mountDir(args,join('/home',user,'.nvm')); mountDir(args,join('/home',user,'.nvm/versions')); mountDir(args,join('/home',user,'.nvm/versions/node')); mountDir(args,nodePrefix); mountDir(args,'/codex-home'); mountDir(args,'/workspace'); mountDir(args,'/skr-state'); mountDir(args,'/skr-state/state'); mountDir(args,'/skr-state/state/responses'); mountDir(args,'/skr');
  args.push('--ro-bind',nodePrefix,nodePrefix,'--bind',privateHome,'/codex-home','--bind',workspace,'/workspace','--ro-bind',state,'/skr-state','--bind',join(state,'state','responses'),'/skr-state/state/responses');
  const skillsRoot=resolve(skillsDir??resolve(dirname(fileURLToPath(import.meta.url)),'../../skills'));
  args.push('--ro-bind',skillsRoot,'/skr/skills');
  const runtimeRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../runtime');
  args.push('--ro-bind',runtimeRoot,'/skr/runtime');
  for(const name of ['request.json','snapshot.json','sources','skills','state','events']) {
    const host=join(workspace,name); try { const st=lstatSync(host); if(st.isFile()||st.isDirectory()||st.isSymbolicLink()) args.push('--ro-bind',host,`/workspace/${name}`); } catch {}
  }
  const pathValue=`${nodeBin}:/usr/local/bin:/usr/bin:/bin`; args.push('--chdir','/workspace','--setenv','HOME','/tmp','--setenv','CODEX_HOME','/codex-home','--setenv','PATH',pathValue,'--setenv','TMPDIR','/tmp',codexPath,...argv);
  return {command:bwrapPath,args,env:{HOME:'/tmp',CODEX_HOME:'/codex-home',PATH:pathValue,TMPDIR:'/tmp',LANG:process.env.LANG??'C.UTF-8'},cwd:workspace};
}
