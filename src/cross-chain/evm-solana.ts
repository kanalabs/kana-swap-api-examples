/**
 * Polygon (POL/MATIC) → Solana (SOL)
 * Flow:
 * 1. Source Swap + Burn (Atomic on Polygon: POL -> USDC -> Burn)
 * 2. Attestation (Circle CCTP)
 * 3. Claim (Mint USDC on Solana)
 * 4. Target Swap (USDC → SOL on Solana)
 */

import axios from "axios";
import "dotenv/config";

import { ethers, BigNumber } from "ethers";
import {
  Connection,
  Keypair,
  VersionedTransaction,
  clusterApiUrl,
} from "@solana/web3.js";
import bs58 from "bs58";

import { KANA_API_URL, NetworkId } from "../constant";

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */

const SOURCE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // POL (Native)
const TARGET_TOKEN = "So11111111111111111111111111111111111111112"; // SOL (Native)

// 1 POL (18 decimals)
const AMOUNT_IN = "1000000000000000000"; 
const SLIPPAGE = 0.5;

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* --------------------------- POLYGON SETUP -------------------------------- */

const polygonProvider = new ethers.providers.JsonRpcProvider(
  process.env.POLYGON_RPC_URL!
);

const polygonSigner = new ethers.Wallet(
  process.env.EVM_PRIVATE_KEY!,
  polygonProvider
);

/* ----------------------------- SOLANA SETUP ------------------------------- */

const solanaConnection = new Connection(
  process.env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta"),
  "confirmed"
);

const solanaSigner = Keypair.fromSecretKey(
  bs58.decode(process.env.SOLANA_PRIVATE_KEY!)
);

/* -------------------------------------------------------------------------- */
/* MAIN FLOW                                                                  */
/* -------------------------------------------------------------------------- */

async function polygonToSolanaSwap() {
  console.log("🚀 Starting Flow: POL (Polygon) -> SOL (Solana)");
  console.log(`👤 Polygon User: ${await polygonSigner.getAddress()}`);
  console.log(`👤 Solana User: ${solanaSigner.publicKey.toBase58()}`);

  /* --------------------------- 1. QUOTE ---------------------------------- */
  const quoteRes = await axios.get(`${KANA_API_URL}/v1/crossChainQuote`, {
    params: {
      sourceToken: SOURCE_TOKEN,
      targetToken: TARGET_TOKEN,
      sourceChain: NetworkId.polygon,
      targetChain: NetworkId.solana,
      amountIn: AMOUNT_IN,
      sourceSlippage: SLIPPAGE,
      targetSlippage: SLIPPAGE,
    },
    headers,
  });

  const quote = quoteRes.data.data[0];
  console.log(`✅ Quote fetched. Est Output: ${quote.outAmount} SOL`);

  /* -------------------- 2. BUILD SOURCE INSTRUCTIONS ---------------------- */
  const transferRes = await axios.post(
    `${KANA_API_URL}/v1/crossChainTransfer`,
    {
      quote,
      sourceAddress: await polygonSigner.getAddress(),
      targetAddress: solanaSigner.publicKey.toBase58(),
    },
    { headers }
  );

  const instruction = transferRes.data.data;
  console.log("✅ Source instructions built");

  /* -------------------- 3. EXECUTE ON POLYGON ----------------------------- */
  // Atomic Swap (POL->USDC) + Burn
  const burnTxHash = await executeEvmInstruction(polygonSigner, instruction);
  console.log("🔥 Atomic Swap & Burn executed on Polygon:", burnTxHash);

  /* -------------------- 4. WAIT FOR ATTESTATION --------------------------- */
  console.log("⏳ Polling for CCTP Attestation...");
  const { messageBytes, attestationSignature } = await waitForAttestation({
    sourceChain: NetworkId.polygon,
    txHash: burnTxHash,
  });
  console.log("🟢 CCTP Attestation Ready");

  /* -------------------- 5. CLAIM (SOLANA) --------------------------------- */
  console.log("📥 Claiming USDC on Solana...");
  const claimRes = await axios.post(
    `${KANA_API_URL}/v1/claim`,
    {
      quote,
      targetAddress: solanaSigner.publicKey.toBase58(),
      messageBytes,
      attestationSignature,
    },
    { headers }
  );

  const claimIx = claimRes.data.data.claimIx;
  const claimTx = VersionedTransaction.deserialize(Buffer.from(claimIx, "base64"));
  claimTx.sign([solanaSigner]);

  const claimSig = await sendSolanaTransaction(solanaConnection, claimTx);
  console.log("🎉 USDC Minted on Solana:", claimSig);

  /* -------------------- 6. TARGET SWAP (USDC -> SOL) ---------------------- */
  if (quote.targetSwapRoute) {
    console.log("🔄 Step 3: Executing Target Swap (USDC -> SOL)...");

    const swapInstructionRes = await axios.post(
      `${KANA_API_URL}/v1/swapInstruction`,
      {
        quote: quote.targetSwapRoute,
        address: solanaSigner.publicKey.toBase58(),
      },
      { headers }
    );

    const swapTxBase64 = swapInstructionRes.data.data.swapTransaction;
    const swapTx = VersionedTransaction.deserialize(Buffer.from(swapTxBase64, "base64"));
    swapTx.sign([solanaSigner]);

    const finalSig = await sendSolanaTransaction(solanaConnection, swapTx);
    console.log("🚀 Final Swap Complete! Sig:", finalSig);
  } else {
    console.log("🏁 No target swap needed.");
  }
}

polygonToSolanaSwap().catch(console.error);

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

async function executeEvmInstruction(
  signer: ethers.Wallet,
  instruction: any
): Promise<string> {
  // 1. Approve
  if (instruction.approveIX) {
    const ix = instruction.approveIX;
    console.log("   -> Approving Token...");
    const tx = await signer.sendTransaction({
      from: ix.from,
      to: ix.to,
      data: ix.data,
      chainId: ix.chainId,
      value: BigNumber.from(ix.value || 0).toHexString(),
      gasPrice: BigNumber.from(ix.gasPrice).toHexString(),
    });
    await tx.wait();
  }

  // 2. Execute Transfer
  const ix = instruction.transferIX;
  console.log("   -> Executing Transaction...");
  const tx = await signer.sendTransaction({
    from: ix.from,
    to: ix.to,
    data: ix.data,
    chainId: ix.chainId,
    value: BigNumber.from(ix.value || 0).toHexString(),
    gasPrice: BigNumber.from(ix.gasPrice).toHexString(),
  });

  const receipt = await tx.wait();
  return receipt.transactionHash;
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
  let attempt = 0;
  let signature: string | null = null;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      if (signature) {
        const status = await provider.getSignatureStatus(signature, { searchTransactionHistory: true });
        if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
          return signature;
        }
      }

      if (!signature || (attempt > 1)) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
        
        signature = await provider.sendRawTransaction(serializedTx, {
          maxRetries: 0, 
          preflightCommitment: "confirmed",
          skipPreflight: true, 
        });

        try {
          await Promise.race([
            provider.confirmTransaction(
              { signature, blockhash, lastValidBlockHeight: 0 },
              "confirmed"
            ),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), STATUS_CHECK_TIMEOUT_MS))
          ]);
          return signature;
        } catch (e) { }
      }
    } catch (error: any) {
      console.log(`   -> Attempt ${attempt} failed: ${error.message}`);
      if (error.message.includes("0x1771")) throw new Error("Slippage Error");
      if (error.message.includes("0x1") && attempt > 2) throw new Error("Insufficient Funds");
      
      signature = null;
    }
  }

  throw new Error(`Failed to send transaction after ${MAX_ATTEMPTS} attempts`);
};

/* ---------------------- CCTP ATTESTATION ---------------------------------- */

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";

const CHAIN_TO_CCTP_ID: Record<number, number> = {
  [NetworkId.ethereum]: 0,
  [NetworkId.Avalanche]: 1,
  [NetworkId.Arbitrum]: 3,
  [NetworkId.solana]: 5,
  [NetworkId.base]: 6,
  [NetworkId.polygon]: 7,
  [NetworkId.aptos]: 9,
};

async function waitForAttestation(params: {
  sourceChain: NetworkId;
  txHash: string;
}) {
  const { sourceChain, txHash } = params;

  while (true) {
    try {
        const url = `${CIRCLE_ATTESTATION_API}/messages/${CHAIN_TO_CCTP_ID[sourceChain]}/${txHash}`;
        const res = await fetch(url);
        const json = await res.json();

        const msg = json?.messages?.[0];  
        if (msg && msg.attestation !== "PENDING") {
        return {
            messageBytes: msg.message,
            attestationSignature: msg.attestation,
        };
        }
    } catch(e) {}

    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 5000));
  }
}