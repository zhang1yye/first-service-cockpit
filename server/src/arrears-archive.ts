import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ARREARS_RAW_ROOT=path.resolve(process.env.ARREARS_RAW_ROOT||path.join(os.homedir(),'cockpit-private','arrears'))
export const EMPTY_FILE_SHA256=crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex')
export type ArchiveIntegrityRow={
  encrypted_archive_dir:string;archive_delete_state:string;archive_deleted_at:string
  archive_ledger_sha256:string;archive_communication_sha256:string;encryption_key_version?:string
  communication_filename?:string;communication_sha256?:string;communication_rows?:number
}
export type ArchiveIntegrityResult={ok:boolean;code:string;reason:string;transient:boolean}
export function arrearsKeyFilePath():string{return process.env.ARREARS_ENCRYPTION_KEY_FILE||path.join(os.homedir(),'.cockpit_arrears_key')}
export function loadArrearsEncryptionKey():Buffer{
  const keyPath=arrearsKeyFilePath()
  if(!fs.existsSync(keyPath))throw new Error('key_unavailable')
  if((fs.statSync(keyPath).mode&0o077)!==0)throw new Error('key_permissions')
  const secret=fs.readFileSync(keyPath,'utf8').trim();if(secret.length<32)throw new Error('key_invalid')
  return crypto.createHash('sha256').update(secret).digest()
}
function verifiedRoot():{configured:string;real:string}{
  try{
    const configured=ARREARS_RAW_ROOT,stat=fs.lstatSync(configured)
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('archive_root_invalid')
    return{configured,real:fs.realpathSync(configured)}
  }catch{throw new Error('archive_root_unavailable')}
}
export function assertArrearsArchiveRoot():string{return verifiedRoot().configured}
export function controlledArrearsArchiveDir(value:string,allowMissing=false):string{
  const {configured,real}=verifiedRoot(),resolved=path.resolve(String(value||'')),name=path.basename(resolved)
  if(!/^\d+$/.test(name)||path.dirname(resolved)!==configured)throw new Error('archive_path_outside_root')
  if(!fs.existsSync(resolved)){if(allowMissing)return resolved;throw new Error('archive_directory_missing')}
  const stat=fs.lstatSync(resolved)
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('archive_directory_invalid')
  const actual=fs.realpathSync(resolved)
  if(path.dirname(actual)!==real||path.basename(actual)!==name)throw new Error('archive_path_outside_root')
  return actual
}
function webBytes(payload:Uint8Array):Uint8Array<ArrayBuffer>{return Uint8Array.from(payload)}
async function sha256(payload:Buffer):Promise<string>{return Buffer.from(await crypto.webcrypto.subtle.digest('SHA-256',webBytes(payload))).toString('hex')}
async function verifyEncryptedFile(filePath:string,expectedSha256:string,key:crypto.webcrypto.CryptoKey):Promise<string|null>{
  let stat:fs.Stats
  try{stat=await fs.promises.lstat(filePath)}catch{return'file_missing'}
  if(!stat.isFile()||stat.isSymbolicLink())return'file_invalid'
  if(stat.size<30||stat.size>16*1024*1024)return'file_size_invalid'
  const payload=await fs.promises.readFile(filePath)
  if(!/^[a-f0-9]{64}$/.test(expectedSha256)||await sha256(payload)!==expectedSha256)return'sha256_mismatch'
  if(payload[0]!==1)return'version_invalid'
  try{
    const ciphertextAndTag=Buffer.concat([payload.subarray(29),payload.subarray(13,29)])
    await crypto.webcrypto.subtle.decrypt({name:'AES-GCM',iv:webBytes(payload.subarray(1,13)),tagLength:128},key,webBytes(ciphertextAndTag))
  }catch{return'gcm_auth_failed'}
  return null
}
async function verifyEncryptedFileAbsent(filePath:string):Promise<'unexpected_file'|'access_failed'|null>{
  try{await fs.promises.lstat(filePath);return'unexpected_file'}
  catch(error:any){return error?.code==='ENOENT'?null:'access_failed'}
}
const transient=(code:string):ArchiveIntegrityResult=>({ok:false,code,reason:'密文校验服务暂不可用',transient:true})
const invalid=(code:string):ArchiveIntegrityResult=>({ok:false,code,reason:'密文归档不完整或校验失败',transient:false})
async function verifyArrearsArchiveInternal(row:ArchiveIntegrityRow):Promise<ArchiveIntegrityResult>{
  if(row.archive_delete_state!=='active'||row.archive_deleted_at)return invalid('archive_inactive')
  if(row.encryption_key_version&&row.encryption_key_version!==process.env.ARREARS_ENCRYPTION_KEY_VERSION)return transient('key_version_unavailable')
  let dir:string
  try{dir=controlledArrearsArchiveDir(row.encrypted_archive_dir)}catch(error:any){const code=String(error?.message||'archive_path_invalid');return code.startsWith('archive_root_')?transient(code):invalid(code)}
  let rawKey:Buffer
  try{rawKey=loadArrearsEncryptionKey()}catch(error:any){return transient(String(error?.message||'key_unavailable'))}
  try{
    const key=await crypto.webcrypto.subtle.importKey('raw',webBytes(rawKey),{name:'AES-GCM'},false,['decrypt'])
    const ledger=await verifyEncryptedFile(path.join(dir,'ledger.enc'),String(row.archive_ledger_sha256||''),key);if(ledger)return invalid(`ledger_${ledger}`)
    if(row.archive_communication_sha256){
      const communications=await verifyEncryptedFile(path.join(dir,'communications.enc'),String(row.archive_communication_sha256),key);if(communications)return invalid(`communications_${communications}`)
    }else{
      // 沟通文件未上传时必须是显式的空元数据，且归档目录不得出现伪造的沟通密文。
      if(String(row.communication_filename??'')!==''||String(row.communication_sha256??'')!==EMPTY_FILE_SHA256||Number(row.communication_rows??-1)!==0)return invalid('communications_absent_metadata_invalid')
      const absent=await verifyEncryptedFileAbsent(path.join(dir,'communications.enc'))
      if(absent==='access_failed')return transient('communications_access_failed')
      if(absent)return invalid(`communications_${absent}`)
    }
    return{ok:true,code:'ok',reason:'',transient:false}
  }catch{return transient('verification_runtime_error')}
}

let activeVerifications=0
const verificationWaiters:Array<()=>void>=[]
const inFlightVerifications=new Map<string,Promise<ArchiveIntegrityResult>>()
async function withVerificationSlot<T>(work:()=>Promise<T>):Promise<T>{
  if(activeVerifications>=2)await new Promise<void>(resolve=>verificationWaiters.push(resolve))
  activeVerifications++
  try{return await work()}finally{activeVerifications--;verificationWaiters.shift()?.()}
}
export function verifyArrearsArchive(row:ArchiveIntegrityRow):Promise<ArchiveIntegrityResult>{
  const identity=[row.encrypted_archive_dir,row.archive_delete_state,row.archive_deleted_at,row.archive_ledger_sha256,row.archive_communication_sha256,row.encryption_key_version,row.communication_filename,row.communication_sha256,row.communication_rows].join('\u0000')
  const existing=inFlightVerifications.get(identity);if(existing)return existing
  if(activeVerifications>=2&&verificationWaiters.length>=20)return Promise.resolve(transient('verification_busy'))
  const task=withVerificationSlot(()=>verifyArrearsArchiveInternal(row)).finally(()=>inFlightVerifications.delete(identity))
  inFlightVerifications.set(identity,task);return task
}
