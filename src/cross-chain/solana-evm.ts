/**
 * Solana (SOL) → Polygon (POL)
 */

import axios from "axios";
import "dotenv/config";
import { 
    Connection, 
    Keypair, 
    VersionedTransaction, 
    clusterApiUrl 
} from "@solana/web3.js";
import { ethers, BigNumber } from "ethers";
import bs58 from "bs58";
import { KANA_API_URL, NetworkId } from "../constant";

/* --------------------------- CONFIG --------------------------------------- */

const SOURCE_TOKEN = "So11111111111111111111111111111111111111112"; // SOL
const TARGET_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // POL
const AMOUNT_IN = "10000000"; // 0.01 SOL
const SLIPPAGE = 1.0;

const headers = { "Content-Type": "application/json", "X-API-KEY": process.env.XYRA_API_KEY! };

/* --------------------------- SETUP ---------------------------------------- */

const solanaConnection = new Connection(process.env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta"), "confirmed");
const solanaSigner = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY!));

const polygonProvider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL!);
const polygonSigner = new ethers.Wallet(process.env.EVM_PRIVATE_KEY!, polygonProvider);

/* -------------------------------------------------------------------------- */
/* MAIN FLOW                                                                  */
/* -------------------------------------------------------------------------- */

async function solanaToPolygonFlow() {
  console.log("🚀 Robust Flow: SOL (Solana) -> POL (Polygon)");
  console.log(`👤 User: ${solanaSigner.publicKey.toBase58()}`);

  // 1. QUOTE
  const quoteRes = await axios.get(`${KANA_API_URL}/v1/crossChainQuote`, {
    params: {
      sourceToken: SOURCE_TOKEN, targetToken: TARGET_TOKEN,
      sourceChain: NetworkId.solana, targetChain: NetworkId.polygon,
      amountIn: AMOUNT_IN, sourceSlippage: SLIPPAGE, targetSlippage: SLIPPAGE,
    }, headers,
  });
  const quote = quoteRes.data.data[0];
  console.log("✅ Quote fetched");

  /* -------------------------------------------------------------------------- */
  /* 2. SOURCE SWAP (SOL -> USDC)                                               */
  /* -------------------------------------------------------------------------- */
  // The crossChainTransfer endpoint for Solana DOES NOT include the swap.
  // We must execute it manually using the route from the quote.
  
  if (quote.sourceSwapRoute) {
    console.log("🔄 Step 1: Executing Source Swap (SOL -> USDC)...");
    
    const swapTxRes = await axios.post(
      `${KANA_API_URL}/v1/swapInstruction`,
      {
        quote: quote.sourceSwapRoute, // Use the route from crossChainQuote
        address: solanaSigner.publicKey.toBase58(),
      },
      { headers }
    );

    const swapTxBase64 = swapTxRes.data.data.swapTransaction;
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTxBase64, "base64"));
    tx.sign([solanaSigner]);

    const swapSig = await sendSolanaTransaction(solanaConnection, tx);
    console.log("✅ Swap Confirmed:", swapSig);
    
    console.log("⏳ Waiting 5s for balance sync...");
    await new Promise(r => setTimeout(r, 5000));
  }

  /* -------------------------------------------------------------------------- */
  /* 3. BRIDGE (USDC -> Burn)                                                   */
  /* -------------------------------------------------------------------------- */
  console.log("🌉 Step 2: Initiating Bridge (USDC -> CCTP Burn)...");

  const transferRes = await axios.post(
    `${KANA_API_URL}/v1/crossChainTransfer`,
    {
      quote,
      sourceAddress: solanaSigner.publicKey.toBase58(),
      targetAddress: polygonSigner.address,
    }, { headers }
  );

  const instruction = transferRes.data.data;
  console.log("✅ Source instructions built");

  // Execute Bridge Instruction
  const burnTxHash = await executeSolanaInstructions(
    solanaConnection,
    solanaSigner,
    instruction
  );
  console.log("🔥 Burn executed:", burnTxHash);

  // 4. ATTESTATION
  console.log("⏳ Polling for Attestation...");
  const { messageBytes, attestationSignature } = await waitForCctpAttestation(burnTxHash);
  console.log("🟢 Attestation ready");

  // 5. CLAIM
  const claimRes = await axios.post(
    `${KANA_API_URL}/v1/claim`,
    { quote, targetAddress: polygonSigner.address, messageBytes, attestationSignature },
    { headers }
  );
  const claimIx = claimRes.data.data.claimIx;
  const mintTx = await polygonSigner.sendTransaction({
    from: claimIx.from,
    to: claimIx.to, 
    data: claimIx.data, 
    chainId: claimIx.chainId,
    gasPrice: BigNumber.from(claimIx.gasPrice).toHexString(),
    value: BigNumber.from(claimIx.value).toHexString()
  });
  await mintTx.wait();
  console.log("🎉 USDC Minted on Polygon");

  // 6. TARGET SWAP
  if (quote.targetSwapRoute) {
    console.log("🔄 Executing Target Swap...");
    const swapInstructionRes = await axios.post(
      `${KANA_API_URL}/v1/swapInstruction`, 
      {
        quote: quote.targetSwapRoute, 
        address: polygonSigner.address,
      }, 
      { headers }
    );
    await executeTargetEVMInstruction(polygonSigner, swapInstructionRes.data.data);
    console.log("🚀 Final swap complete");
  }
}

solanaToPolygonFlow().catch(console.error);

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

async function executeSolanaInstructions(
  connection: Connection,
  signer: Keypair,
  instruction: any
): Promise<string> {
  let lastTx = "";

  // Note: Since we handled Source Swap manually above, this usually won't fire 
  // for Solana source chains, but kept for compatibility.
  if (instruction.swapTransaction) {
    console.log("   -> Executing Swap (from instructions)...");
    const tx = VersionedTransaction.deserialize(Buffer.from(instruction.swapTransaction, "base64"));
    tx.sign([signer]);
    const sig = await sendSolanaTransaction(connection, tx);
    console.log("   -> Swap Confirmed:", sig);
    await new Promise(r => setTimeout(r, 2000));
  }

  // Execute Bridge (Transfer)
  if (instruction.transferTx) {
    console.log("   -> Executing Bridge Burn...");
    const tx = VersionedTransaction.deserialize(Buffer.from(instruction.transferTx, "base64"));
    tx.sign([signer]);
    
    const sig = await sendSolanaTransaction(connection, tx);
    lastTx = sig;
  }

  return lastTx;
}

export const sendSolanaTransaction = async (
  provider: Connection,
  transaction: VersionedTransaction
): Promise<string> => {
  const serializedTx = transaction.serialize();
  
  const RETRY_INTERVAL_MS = 3000;
  const MAX_ATTEMPTS = 5;
  const STATUS_CHECK_TIMEOUT_MS = 5000;
  
  const blockhash = transaction.message.recentBlockhash as string;
  let lastError: Error | null = null;
  let attempt = 0;
  let signature: string | null = null;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      // 1. Check if previously sent signature is now confirmed
      if (signature) {
        const status = await provider.getSignatureStatus(signature, { searchTransactionHistory: true });
        if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
          return signature;
        }
      }

      // 2. Send Transaction (Retry strategy)
      if (!signature || (attempt > 1)) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
        
        signature = await provider.sendRawTransaction(serializedTx, {
          maxRetries: 0, 
          preflightCommitment: "confirmed",
          skipPreflight: true, // Important for retries
        });

        // 3. Wait for Confirmation
        try {
          await Promise.race([
            provider.confirmTransaction(
              { signature, blockhash, lastValidBlockHeight: 0 },
              "confirmed"
            ),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), STATUS_CHECK_TIMEOUT_MS))
          ]);
          return signature;
        } catch (e) {
          // Confirmation timed out, loop back and retry
        }
      }
    } catch (error: any) {
      lastError = error;
      console.log(`   -> Attempt ${attempt} failed: ${error.message}`);
      
      if (error.message.includes("0x1771")) {
        throw new Error("Slippage: Out Amount less than minimum");
      }
      
      if (error.message.includes("0x1") && attempt > 2) {
         throw new Error("Insufficient funds (0x1).");
      }
      
      signature = null;
    }
  }

  throw lastError || new Error(`Failed to send transaction after ${MAX_ATTEMPTS} attempts`);
};

async function executeTargetEVMInstruction(signer: ethers.Wallet, instruction: any) {
  if (instruction.approveIX) {
    const tx = await signer.sendTransaction({ ...instruction.approveIX, gasLimit: BigNumber.from(150000) });
    await tx.wait();
  }
  if (instruction.swapIX) {
    const tx = await signer.sendTransaction({ ...instruction.swapIX, gasLimit: BigNumber.from(1000000) });
    await tx.wait();
  }
}

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";
async function waitForCctpAttestation(txHash: string) {
  while (true) {
    try {
        const res = await fetch(`${CIRCLE_ATTESTATION_API}/messages/5/${txHash}`);
        const json = await res.json();
        if (json?.messages?.[0]?.attestation !== "PENDING") {
            return { messageBytes: json.messages[0].message, attestationSignature: json.messages[0].attestation };
        }
    } catch(e) {}
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 5000));
  }
}