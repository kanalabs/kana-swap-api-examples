/**
 * Solana (SOL) → Aptos (USDC)
 *
 * Flow:
 * 1. Quote
 * 2. CrossChainTransfer (Solana burn tx)
 * 3. Wait for FINALIZED Solana burn
 * 4. Poll Circle CCTP attestation
 * 5. Claim on Aptos (mint USDC)
 */

import axios from "axios";
import "dotenv/config";

import {
  Connection,
  Keypair,
  PublicKey,
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
/*                                  CONFIG                                    */
/* -------------------------------------------------------------------------- */

const SOURCE_TOKEN = "So11111111111111111111111111111111111111112"; // SOL
const TARGET_TOKEN =
  "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b"; // Aptos USDC

const AMOUNT_IN = "10000000"; // ✅ 0.01 SOL (lamports)
const SLIPPAGE = 1;

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* ---------------------------- SOLANA SETUP -------------------------------- */

const solanaConnection = new Connection(
  clusterApiUrl("mainnet-beta"),
  {
    commitment: "confirmed",
  }
);

const solanaSigner = Keypair.fromSecretKey(
  bs58.decode(process.env.SOLANA_PRIVATE_KEY!)
);

/* ----------------------------- APTOS SETUP -------------------------------- */

const aptos = new Aptos(
  new AptosConfig({ network: Network.MAINNET })
);

const aptosAccount = new Ed25519Account({
  privateKey: new Ed25519PrivateKey(
    PrivateKey.formatPrivateKey(
      process.env.APTOS_PRIVATE_KEY!,
      PrivateKeyVariants.Ed25519
    )
  ),
});

/* -------------------------------------------------------------------------- */
/*                                   MAIN                                     */
/* -------------------------------------------------------------------------- */

async function solanaToAptosSwap() {
  /* --------------------------- 1. QUOTE ---------------------------------- */
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
  console.log("✅ Quote fetched");

  /* ---------------------- 2. BUILD TRANSFER ------------------------------- */
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
  console.log("✅ Source instructions built");

  /* -------------------- 3. EXECUTE ON SOLANA (BURN) ----------------------- */
  const burnTxHash = await executeSolanaTx(
    solanaConnection,
    solanaSigner,
    transferTxBase64
  );

  console.log("🔥 Burn FINALIZED on Solana:", burnTxHash);

  /* -------------------- 4. WAIT FOR CCTP ATTESTATION ---------------------- */
  const { messageBytes, attestationSignature } =
    await waitForCctpAttestation(burnTxHash);

  console.log("🟢 CCTP attestation ready");

  /* -------------------- 5. CLAIM ON APTOS (MINT) -------------------------- */
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

  const claimPayload = claimRes.data.data.claimPayload;
  console.log("✅ Claim payload received");

  const mintTxHash = await executeAptosClaim(
    aptos,
    aptosAccount,
    claimPayload
  );

  console.log("🎉 USDC minted on Aptos:", mintTxHash);
}

solanaToAptosSwap();

/* -------------------------------------------------------------------------- */
/*                                HELPERS                                     */
/* -------------------------------------------------------------------------- */

async function executeSolanaTx(
  connection: Connection,
  signer: Keypair,
  base64Tx: string
): Promise<string> {
  const tx = VersionedTransaction.deserialize(
    Buffer.from(base64Tx, "base64")
  );

  tx.sign([signer]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  console.log("📤 Solana tx sent:", sig);

  const status = await connection.confirmTransaction(
    {
      signature: sig,
      ...(await connection.getLatestBlockhash("confirmed")),
    },
    "finalized"
  );

  if (status.value.err) {
    throw new Error("Solana burn transaction failed");
  }

  return sig;
}

/* ----------------------- APTOS CLAIM EXECUTION ---------------------------- */

async function executeAptosClaim(
  aptos: Aptos,
  signer: Ed25519Account,
  payload: any
): Promise<string> {
  const tx = await aptos.transaction.build.simple({
    sender: signer.accountAddress.toString(),
    data: {
      function: payload.function as `${string}::${string}::${string}`,
      typeArguments: payload.type_arguments,
      functionArguments: payload.arguments,
    },
  });

  const res = await aptos.signAndSubmitTransaction({
    signer,
    transaction: tx,
  });

  await aptos.waitForTransaction({
    transactionHash: res.hash,
    options: { checkSuccess: true },
  });

  return res.hash;
}

/* ---------------------- CCTP ATTESTATION POLLING -------------------------- */

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";

async function waitForCctpAttestation(txHash: string) {
  const cctpChainId = 5; // Solana

  while (true) {
    const res = await fetch(
      `${CIRCLE_ATTESTATION_API}/messages/${cctpChainId}/${txHash}`
    );
    const json = await res.json();

    const msg = json?.messages?.[0];
    if (msg && msg.attestation !== "PENDING") {
      return {
        messageBytes: msg.message,
        attestationSignature: msg.attestation,
      };
    }

    await new Promise((r) => setTimeout(r, 5000));
  }
}
