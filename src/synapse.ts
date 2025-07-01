import type { Buffer } from 'buffer';

// --- Type Definitions (Updated to match the error message) ---
interface StorageInstance {
  preflightUpload(size: number): Promise<any>;
  upload(buffer: Buffer, options: any): Promise<any>;
  proofSetId: string; // <-- FIX #1: This MUST be a string.
}
interface Synapse {
  createStorage(options: any): Promise<StorageInstance>;
}
interface SynapseModule {
    Synapse: {
        create(options: any): Promise<Synapse>;
    };
}
interface UploadOptions {
  proofSetId?: number;
}
interface SynapseEnv {
  SYNAPSE_PRIVATE_KEY?: string;
  SYNAPSE_NETWORK?: string;
  SYNAPSE_RPC_URL?: string;
}
export interface UploadResult {
  commp: string;
  size: number;
  proofSetId: string; // <-- FIX #2: This should also be a string to be consistent.
}

let synapseInstance: Synapse | null = null;

export async function getSynapse(synapseEnv: SynapseEnv): Promise<Synapse> {
  if (!synapseInstance) {
    console.log(`[SYNAPSE] Initializing Synapse SDK for network: ${synapseEnv.SYNAPSE_NETWORK}`);
    const { Synapse }: SynapseModule = await import('@filoz/synapse-sdk');
    synapseInstance = await Synapse.create({
      privateKey: synapseEnv.SYNAPSE_PRIVATE_KEY,
      rpcURL: synapseEnv.SYNAPSE_RPC_URL,
      withCDN: true,
    });
    console.log('[SYNAPSE] SDK Initialized.');
  }
  return synapseInstance;
}

export async function uploadData(
  dataBuffer: Buffer,
  options: UploadOptions = {},
  synapseEnv: SynapseEnv = {}): Promise<UploadResult> {
  if (!synapseEnv.SYNAPSE_PRIVATE_KEY || !synapseEnv.SYNAPSE_NETWORK || !synapseEnv.SYNAPSE_RPC_URL) {
    throw new Error(".env or secrets are incomplete");
  }

  const synapse = await getSynapse(synapseEnv);
  const storage = await synapse.createStorage({
    proofSetId: 353, // Can be undefined
    withCDN: true, // Explicitly set here too for robustness
  });

  
  const preflight = await storage.preflightUpload(dataBuffer.length);
  if (!preflight.allowanceCheck.sufficient) {
    throw new Error('Allowance not sufficient to upload file.');
  }
  
  const uploadResult = await storage.upload(dataBuffer, {});

  console.log(`[SYNAPSE] Successfully uploaded. CommP: ${uploadResult.commp}`);
  return {
    commp: uploadResult.commp.toString(),
    size: uploadResult.size,
    proofSetId: storage.proofSetId, // <-- FIX #3: No change needed here, as it's now correctly string-to-string.
  };
}