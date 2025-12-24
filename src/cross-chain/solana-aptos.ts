/**
 * Solana (SOL) → Aptos (APT)
 */

import axios from "axios";
import "dotenv/config";

import {
  Connection,
  Keypair,
  VersionedTransaction,
  clusterApiUrl,
} from "@solana/web3.js";

import {
  Aptos,
  AptosConfig,
  Ed25519Account,
  Ed25519PrivateKey,
  Network,
  PrivateKey,
  PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";

import bs58 from "bs58";
import { NetworkId, KANA_API_URL } from "../constant";

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */

const SOURCE_TOKEN = "So11111111111111111111111111111111111111112"; // SOL
const TARGET_TOKEN = "0x1::aptos_coin::AptosCoin"; // APT

const AMOUNT_IN = "10000000"; // 0.01 SOL
const SLIPPAGE = 1.0;

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* ---------------------------- SETUP --------------------------------------- */

const solanaConnection = new Connection(
  process.env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta"),
  "confirmed"
);

const solanaSigner = Keypair.fromSecretKey(
  bs58.decode(process.env.SOLANA_PRIVATE_KEY!)
);

const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET }));
const aptosAccount = new Ed25519Account({
  privateKey: new Ed25519PrivateKey(
    PrivateKey.formatPrivateKey(
      process.env.APTOS_PRIVATE_KEY!,
      PrivateKeyVariants.Ed25519
    )
  ),
});

/* -------------------------------------------------------------------------- */
/* MAIN FLOW                                                                  */
/* -------------------------------------------------------------------------- */

async function solanaToAptosFlow() {
  console.log("🚀 Robust Flow: SOL (Solana) -> APT (Aptos)");
  console.log(`👤 Solana User: ${solanaSigner.publicKey.toBase58()}`);

  /* --------------------------- 1. QUOTE ---------------------------------- */
  // We fetch the quote once to get the route details
  const quoteRes = await axios.get(`${KANA_API_URL}/v1/crossChainQuote`, {
    params: {
      sourceToken: SOURCE_TOKEN,
      targetToken: TARGET_TOKEN,
      sourceChain: NetworkId.solana,
      targetChain: NetworkId.aptos,
      amountIn: AMOUNT_IN,
      sourceSlippage: SLIPPAGE,
      targetSlippage: SLIPPAGE,
    },
    headers,
  });

  const quote = quoteRes.data.data[0];
  console.log(`✅ Quote fetched. Bridge Amount: ${quote.bridgeAmount}`);

  /* -------------------------------------------------------------------------- */
  /* 2. SOURCE SWAP (With Smart Retry)                                          */
  /* -------------------------------------------------------------------------- */
  if (quote.sourceSwapRoute) {
    let swapSuccess = false;
    let attempts = 0;

    // Loop until success or max retries
    while (!swapSuccess && attempts < 5) {
      attempts++;
      try {
        console.log(`🔄 Step 1: Executing Swap (Attempt ${attempts})...`);

        // A. Always fetch a FRESH transaction (New Blockhash)
        const swapTxRes = await axios.post(
          `${KANA_API_URL}/v1/swapInstruction`,
          {
            quote: quote.sourceSwapRoute,
            address: solanaSigner.publicKey.toBase58(),
          },
          { headers }
        );

        const swapTxBase64 = swapTxRes.data.data.swapTransaction;
        const tx = VersionedTransaction.deserialize(Buffer.from(swapTxBase64, "base64"));
        tx.sign([solanaSigner]);

        // B. Send
        const swapSig = await sendSolanaTransaction(solanaConnection, tx);
        console.log("✅ Swap Confirmed:", swapSig);
        swapSuccess = true;

        console.log("⏳ Waiting 5s for balance sync...");
        await new Promise(r => setTimeout(r, 5000));

      } catch (e: any) {
        if (e.message.includes("Expired") || e.message.includes("block height")) {
          console.warn("⚠️  Tx Expired (Network Congested). Fetching fresh blockhash...");
          // Continue loop -> Fetch new API response
        } else {
          throw e; // Fatal error
        }
      }
    }
    
    if (!swapSuccess) throw new Error("Swap failed after 5 attempts due to congestion.");
  }

  /* -------------------------------------------------------------------------- */
  /* 3. BRIDGE (With Smart Retry)                                               */
  /* -------------------------------------------------------------------------- */
  console.log("🌉 Step 2: Initiating Bridge...");
  
  let bridgeSuccess = false;
  let bridgeAttempts = 0;
  let burnTxHash = "";

  while (!bridgeSuccess && bridgeAttempts < 5) {
    bridgeAttempts++;
    try {
      // A. Fetch FRESH Bridge Transaction
      const transferRes = await axios.post(
        `${KANA_API_URL}/v1/crossChainTransfer`,
        {
          quote,
          sourceAddress: solanaSigner.publicKey.toBase58(),
          targetAddress: aptosAccount.accountAddress.toString(),
        },
        { headers }
      );

      const transferTxBase64 = transferRes.data.data.transferTx;
      const burnTx = VersionedTransaction.deserialize(Buffer.from(transferTxBase64, "base64"));
      burnTx.sign([solanaSigner]);

      // B. Send
      burnTxHash = await sendSolanaTransaction(solanaConnection, burnTx);
      console.log("🔥 Burn FINALIZED on Solana:", burnTxHash);
      bridgeSuccess = true;

    } catch (e: any) {
      if (e.message.includes("Expired") || e.message.includes("block height")) {
        console.warn("⚠️  Bridge Tx Expired. Retrying with fresh transaction...");
      } else {
        throw e;
      }
    }
  }

  if (!burnTxHash) throw new Error("Bridge failed after retries.");

  /* --------------------------- 4. ATTESTATION ----------------------------- */
  console.log("⏳ Polling for CCTP Attestation...");
  const { messageBytes, attestationSignature } =
    await waitForCctpAttestation(burnTxHash);
  console.log("🟢 Attestation Ready");

  /* ----------------------------- 5. CLAIM --------------------------------- */
  console.log("📥 Claiming USDC on Aptos...");
  const claimRes = await axios.post(
    `${KANA_API_URL}/v1/claim`,
    {
      quote,
      targetAddress: aptosAccount.accountAddress.toString(),
      messageBytes,
      attestationSignature,
    },
    { headers }
  );

  await executeAptosInstruction(
    aptos,
    aptosAccount,
    claimRes.data.data.claimPayload
  );
  console.log("🎉 USDC Minted on Aptos");

  /* -------------------------- 6. TARGET SWAP ------------------------------ */
  if (quote.targetSwapRoute) {
    console.log("🔄 Step 3: Executing Target Swap (USDC -> APT)...");

    const swapInstructionRes = await axios.post(
      `${KANA_API_URL}/v1/swapInstruction`,
      {
        quote: quote.targetSwapRoute, 
        address: aptosAccount.accountAddress.toString(),
      },
      { headers }
    );

    const finalHash = await executeAptosInstruction(
      aptos,
      aptosAccount,
      swapInstructionRes.data.data
    );
    
    console.log("🚀 Final Swap Complete! Hash:", finalHash);
  }
}

solanaToAptosFlow().catch(console.error);

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

export const sendSolanaTransaction = async (
  provider: Connection,
  transaction: VersionedTransaction
): Promise<string> => {
  const serializedTx = transaction.serialize();
  const blockhash = transaction.message.recentBlockhash as string;
  let attempt = 0;
  let signature: string | null = null;

  while (attempt < 10) { 
    attempt++;
    try {
      // 1. Check status
      if (signature) {
        const status = await provider.getSignatureStatus(signature);
        if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
          return signature;
        }
        // If block height exceeded, stop retrying this specific tx
        if (status?.value?.err?.toString().includes("BlockHeightExceeded")) {
             throw new Error("Expired");
        }
      }

      // 2. Send (Skip Preflight to just get it out there)
      if (!signature || (attempt > 1)) {
        if(attempt > 1) await new Promise(r => setTimeout(r, 2000));
        
        signature = await provider.sendRawTransaction(serializedTx, {
          skipPreflight: true,
          maxRetries: 0
        });
      }
      
      // 3. Check Expiration via Blockheight
      // We check if the blockhash is still valid
      const isBlockhashValid = await provider.isBlockhashValid(blockhash, { commitment: "processed" });
      if (!isBlockhashValid.value) {
          throw new Error("Expired: block height exceeded");
      }

    } catch (error: any) {
      if (error.message.includes("Expired") || error.message.includes("block height")) {
          throw new Error("Expired");
      }
    }
  }
  throw new Error("Transaction failed to land (timeout)");
};

async function executeAptosInstruction(aptos: Aptos, signer: Ed25519Account, payload: any): Promise<string> {
  const tx = await aptos.transaction.build.simple({
    sender: signer.accountAddress.toString(),
    data: {
      function: payload.function,
      typeArguments: payload.type_arguments,
      functionArguments: payload.arguments,
    },
  });
  const res = await aptos.signAndSubmitTransaction({ signer, transaction: tx });
  await aptos.waitForTransaction({ transactionHash: res.hash, options: { checkSuccess: true } });
  return res.hash;
}

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";
async function waitForCctpAttestation(txHash: string) {
  while (true) {
    try {
      const res = await fetch(`${CIRCLE_ATTESTATION_API}/messages/5/${txHash}`);
      const json = await res.json();
      if (json?.messages?.[0]?.attestation !== "PENDING") {
        return {
          messageBytes: json.messages[0].message,
          attestationSignature: json.messages[0].attestation,
        };
      }
    } catch (e) {}
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 5000));
  }
}