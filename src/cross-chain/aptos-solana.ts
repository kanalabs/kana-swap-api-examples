/**
 * Example: Aptos → Solana cross-chain swap (FULL FLOW)
 * Swap → Burn → Attestation → Claim → Mint (ATA)
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

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  clusterApiUrl,
} from "@solana/web3.js";

import bs58 from "bs58";
import { KANA_API_URL, NetworkId } from "../constant";

/* -------------------------------------------------------------------------- */
/*                                  CONFIG                                    */
/* -------------------------------------------------------------------------- */

const SOURCE_TOKEN = "0x1::aptos_coin::AptosCoin"; // APT
const TARGET_TOKEN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC (Solana)
const AMOUNT_IN = "1000000"; // 0.1 APT
const SLIPPAGE = 0.5;

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

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

/* ---------------------------- SOLANA SETUP -------------------------------- */

const solanaSigner = Keypair.fromSecretKey(
  bs58.decode(process.env.SOLANA_PRIVATE_KEY!)
);

const solanaConnection = new Connection(
  clusterApiUrl("mainnet-beta"),
  "confirmed"
);

/* -------------------------------------------------------------------------- */
/*                                  MAIN FLOW                                 */
/* -------------------------------------------------------------------------- */

async function aptosToSolanaSwap() {
  /* --------------------------- 1. QUOTE ---------------------------------- */
  const quoteRes = await axios.get(`${KANA_API_URL}/v1/crossChainQuote`, {
    params: {
      sourceToken: SOURCE_TOKEN,
      targetToken: TARGET_TOKEN,
      sourceChain: NetworkId.aptos,
      targetChain: NetworkId.solana,
      amountIn: AMOUNT_IN,
      sourceSlippage: SLIPPAGE,
      targetSlippage: SLIPPAGE,
    },
    headers,
  });

  const quote = quoteRes.data.data[0];
  console.log("✅ Quote fetched");

  /* ------------------- 2. DERIVE SOLANA ATA ------------------------------- */
  const usdcMint = new PublicKey(quote.targetBridgeToken);

  const ata = await getAssociatedTokenAddress(
    usdcMint,
    solanaSigner.publicKey
  );

  console.log("🎯 Target USDC ATA:", ata.toBase58());

  /* ------------------ 3. BUILD SOURCE INSTRUCTIONS ------------------------ */
  const instructionRes = await axios.post(
    `${KANA_API_URL}/v1/crossChainTransfer`,
    {
      quote,
      sourceAddress: aptosAccount.accountAddress.toString(),
      targetAddress: ata.toBase58(),
    },
    { headers }
  );

  const instruction = instructionRes.data.data;
  console.log("✅ Source instructions built");

  /* ------------------ 4. EXECUTE ON APTOS (BURN) -------------------------- */
  const aptosTxHash = await executeAptosInstruction(
    aptos,
    aptosAccount,
    instruction.bridgePayload
  );

  console.log("🔥 Burn executed on Aptos:", aptosTxHash);

  /* ------------------ 5. WAIT FOR CCTP ATTESTATION ------------------------ */
  const { messageBytes, attestationSignature } =
    await waitForAttestation({
      sourceChain: NetworkId.aptos,
      txHash: aptosTxHash,
    });

  console.log("🟢 CCTP attestation ready");

  /* ------------------ 6. CLAIM (SOLANA MINT) ------------------------------ */
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
  console.log("✅ Claim instruction received");

  /* ------------------ 7. EXECUTE ON SOLANA -------------------------------- */
  const txSig = await executeSolanaInstruction(
    solanaConnection,
    solanaSigner,
    claimIx
  );

  console.log("🎉 Minted on Solana:", txSig);
}

aptosToSolanaSwap();

/* -------------------------------------------------------------------------- */
/*                                HELPERS                                     */
/* -------------------------------------------------------------------------- */

function formatFunctionName(
  fn: string
): `${string}::${string}::${string}` {
  return fn as `${string}::${string}::${string}`;
}

async function executeAptosInstruction(
  aptos: Aptos,
  signer: Ed25519Account,
  payload: {
    function: string;
    type_arguments: string[];
    arguments: any[];
  }
): Promise<string> {
  const tx = await aptos.transaction.build.simple({
    sender: signer.accountAddress.toString(),
    data: {
      function: formatFunctionName(payload.function),
      typeArguments: payload.type_arguments,
      functionArguments: payload.arguments,
    },
    options: {
      gasUnitPrice: 100,
      maxGasAmount: 4000,
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

/* ---------------------------- SOLANA EXEC -------------------------------- */

async function executeSolanaInstruction(
  connection: Connection,
  signer: Keypair,
  base64Tx: string
): Promise<string> {
  const decoded = Buffer.from(base64Tx, "base64");
  const tx = VersionedTransaction.deserialize(decoded);

  tx.message.recentBlockhash = (
    await connection.getLatestBlockhash("confirmed")
  ).blockhash;

  tx.sign([signer]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });

  await connection.confirmTransaction(sig, "confirmed");
  return sig;
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

async function waitForAttestation(params: {
  sourceChain: NetworkId;
  txHash: string;
}) {
  const { sourceChain, txHash } = params;

  while (true) {
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

    await new Promise((r) => setTimeout(r, 3000));
  }
}

/* --------------------- SOLANA ATA HELPERS --------------------------------- */

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

async function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const [address] = await PublicKey.findProgramAddress(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  return address;
}
