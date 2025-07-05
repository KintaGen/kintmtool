import type { Buffer } from 'buffer';
import { acquireLock, releaseLock } from './lock.service'; // <-- Import the lock

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
  synapseEnv: SynapseEnv = {}): Promise<UploadResult> {
  if (!synapseEnv.SYNAPSE_PRIVATE_KEY || !synapseEnv.SYNAPSE_NETWORK || !synapseEnv.SYNAPSE_RPC_URL) {
    throw new Error(".env or secrets are incomplete");
  }

  // 1. Acquire the lock BEFORE starting any async operations.
  // This will make subsequent requests wait here until the lock is free.
  await acquireLock();

  // We wrap the entire logic in a new Promise to control when it resolves.
  return new Promise(async (resolve, reject) => {
    try {
      // --- Standard Setup Logic ---
      const synapse = await getSynapse(synapseEnv);
      const storage = await synapse.createStorage({
        proofSetId: undefined,
        withCDN: true,
        callbacks: {
          onProviderSelected: (provider :any) => console.log(`[SYNAPSE] Provider selected: ${provider.owner}`),
          onProofSetResolved: (info: any) => console.log(`[SYNAPSE] Proof set resolved. ID: ${info.proofSetId}, Is Existing: ${info.isExisting}`),
          onProofSetCreationStarted: (tx: any) => console.log(`[SYNAPSE] New proof set creation Tx: ${tx.hash}`),
          onProofSetCreationProgress: (status: any) => console.log(`[SYNAPSE] Creation progress: Mined=${status.transactionMined}, Live=${status.proofSetLive}`),
        }
      });
      await storage.preflightUpload(dataBuffer.length);
      
      console.log(`[SYNAPSE] Starting upload of ${dataBuffer.length} bytes...`);

      let capturedCommp: any = null;
      let hasResolvedForUser: boolean = false; // Flag to ensure we only resolve once

      // 2. We do NOT await this. We let it run in the background and use its callbacks.
      // We attach .then() and .catch() to its promise to handle the FINAL lock release.
      storage.upload(dataBuffer, {
        onUploadComplete: (commp: any) => {
          console.log(`[SYNAPSE CALLBACK] Upload to provider complete. CommP: ${commp}`);
          capturedCommp = commp;
        },
        onRootAdded: (tx: any) => {
          // 3. This is the FAST resolve for the user.
          if (hasResolvedForUser) return;
          hasResolvedForUser = true;

          console.log(`[SYNAPSE CALLBACK] Root addition transaction sent: ${tx?.hash}. RESOLVING PROMISE FOR USER NOW.`);
          
          resolve({
            commp: capturedCommp.toString(),
            size: dataBuffer.length,
            proofSetId: storage.proofSetId,
          });
        },
        onRootConfirmed: (rootIds: any) => {
          console.log(`[SYNAPSE CALLBACK] (Info only) Root IDs confirmed on-chain later: ${rootIds.join(', ')}`);
          // The .then() block below will handle the lock release.
        },
      })
      .then(() => {
        // 4a. SUCCESS CASE: The entire process, including confirmation, is done. Release the lock.
        console.log('[SYNAPSE] Full upload process (including confirmation) finished successfully.');
        releaseLock();
      })
      .catch(error => {
        // 4b. FAILURE CASE: The upload process failed at some point.
        console.error('[SYNAPSE] Upload process failed.', error);
        // If we haven't already responded to the user, we need to reject the main promise.
        if (!hasResolvedForUser) {
          reject(error);
        }
        // CRUCIAL: Always release the lock, even on failure.
        releaseLock();
      });

    } catch (initialError) {
      // This catches errors from getSynapse, createStorage, or preflightUpload.
      console.error('[SYNAPSE] Initial setup failed.', initialError);
      // We must release the lock and reject the promise.
      releaseLock();
      reject(initialError);
    }
  });
}