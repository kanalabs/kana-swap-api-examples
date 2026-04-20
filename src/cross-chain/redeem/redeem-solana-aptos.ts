/**
 * Redeem flow: Solana → Aptos
 */

import axios from "axios";
import "dotenv/config";
import {
  Aptos,
  AptosConfig,
  Ed25519Account,
  Ed25519PrivateKey,
  Network,
  PrivateKey,
  PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";

import { KANA_API_URL, NetworkId } from "../../constant";

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */

const SOLANA_BURN_TX_HASH = process.env.SOLANA_BURN_TX_HASH!;

if (!SOLANA_BURN_TX_HASH) {
    throw new Error("❌ Missing SOLANA_BURN_TX_HASH in .env");
}

const BRIDGE_ID_CCTP = 3; 

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* ----------------------------- APTOS SETUP -------------------------------- */

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

async function redeemSolanaToAptos() {
  console.log("🚀 Starting Redeem: Solana -> Aptos");
  console.log("🔹 Burn Hash:", SOLANA_BURN_TX_HASH);
  console.log(`👤 Target Aptos User: ${aptosAccount.accountAddress.toString()}`);

  /* -------------------- 1. WAIT FOR ATTESTATION --------------------------- */
  console.log("⏳ Polling for CCTP Attestation...");
  
  const { messageBytes, attestationSignature } = await waitForAttestation(
    NetworkId.solana, 
    SOLANA_BURN_TX_HASH
  );
  console.log("🟢 CCTP Attestation Ready!");

  /* -------------------- 2. BUILD REDEEM PAYLOAD --------------------------- */
  console.log("🛠️ Fetching redeem instruction from API...");
  
  try {
    const res = await axios.post(`${KANA_API_URL}/v1/redeem`, {
      sourceChainID: NetworkId.solana,
      targetChainID: NetworkId.aptos, 
      bridgeID: BRIDGE_ID_CCTP,
      targetAddress: aptosAccount.accountAddress.toString(),
      messageBytes: [messageBytes], 
      attestationSignature: [attestationSignature], 
    }, { headers });

    const redeemData = res.data.data;
    
    const aptosPayload = redeemData.claimPayload || redeemData.claimIx || redeemData;

    if (!aptosPayload || !aptosPayload.function) {
        console.error("❌ Invalid response:", redeemData);
        throw new Error("API did not return a valid Aptos Move payload.");
    }

    console.log("✅ Redeem instruction built");

    /* -------------------- 3. EXECUTE ON APTOS ----------------------------- */
    console.log("📤 Submitting Redeem Transaction to Aptos...");

    const mintTxHash = await executeAptosInstruction(
        aptos,
        aptosAccount,
        aptosPayload
    );

    console.log("🎉 Success! Redeem confirmed on Aptos.");
    console.log("🔗 Tx Hash:", mintTxHash);

  } catch (e: any) {
      if (e.response) {
          console.error("❌ API Error:", JSON.stringify(e.response.data, null, 2));
      } else {
          console.error("❌ Error:", e.message);
      }
  }
}

redeemSolanaToAptos().catch(console.error);

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

function formatFunctionName(fn: string): `${string}::${string}::${string}` {
  return fn as `${string}::${string}::${string}`;
}

async function executeAptosInstruction(
  aptos: Aptos,
  signer: Ed25519Account,
  payload: any
): Promise<string> {
  const tx = await aptos.transaction.build.simple({
    sender: signer.accountAddress.toString(),
    data: {
      function: formatFunctionName(payload.function),
      typeArguments: payload.type_arguments,
      functionArguments: payload.arguments,
    },
  });

  const res = await aptos.signAndSubmitTransaction({
    signer,
    transaction: tx,
  });

  console.log("   -> Tx Sent. Waiting for confirmation...");
  await aptos.waitForTransaction({
    transactionHash: res.hash,
    options: { checkSuccess: true },
  });

  return res.hash;
}

/* ---------------------- CCTP ATTESTATION POLLING -------------------------- */

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";

const CHAIN_TO_CCTP_ID: Record<number, number> = {
  [NetworkId.ethereum]: 0,
  [NetworkId.Avalanche]: 1,
  [NetworkId.Arbitrum]: 3,
  [NetworkId.solana]: 5,
  [NetworkId.base]: 6,
  [NetworkId.polygon]: 7,
  [NetworkId.sui]: 8,
  [NetworkId.aptos]: 9,
};

async function waitForAttestation(sourceChain: number, txHash: string) {
  const pollInterval = 5000; 
  
  while (true) {
    try {
      const url = `${CIRCLE_ATTESTATION_API}/messages/${CHAIN_TO_CCTP_ID[sourceChain]}/${txHash}`;
      const res = await fetch(url);
      
      if (res.ok) {
        const json = await res.json();
        const msg = json?.messages?.[0];
        
        if (msg && msg.attestation !== 'PENDING') {
          return { 
            messageBytes: msg.message, 
            attestationSignature: msg.attestation 
          };
        }
      }
    } catch (e) {}
    
    process.stdout.write(".");
    await new Promise(r => setTimeout(r, pollInterval));
  }
}