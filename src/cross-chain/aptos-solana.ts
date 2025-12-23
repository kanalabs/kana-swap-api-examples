/**
 * Aptos → Solana Cross-Chain Swap
 * Swap → Burn → Attestation → Claim → Mint → Target Swap
 */

import "dotenv/config";
import { Aptos, AptosConfig, Ed25519Account, Ed25519PrivateKey, Network, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import bs58 from "bs58";

import { NetworkId } from "../constant";

// helpers
import { getCrossChainQuote, buildCrossChainInstruction } from "./helpers/kana";
import { executeAptosBurn } from "./helpers/aptos";
import { waitForAttestation } from "./helpers/attestation";
import { claimOnSolana } from "./helpers/kana";
import { executeSolanaInstruction, executeSolanaSwap, getSolanaSwapQuote } from "./helpers/solana";
import { deriveSolanaATA } from "./helpers/ata";

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                      */
/* -------------------------------------------------------------------------- */

const SOURCE_TOKEN = "0x1::aptos_coin::AptosCoin"; // APT
const TARGET_TOKEN = "So11111111111111111111111111111111111111112"; // SOL
const AMOUNT_IN = "1000000"; // 0.1 APT
const SLIPPAGE = 0.5;

/* -------------------------------------------------------------------------- */
/* APTOS SETUP                                                                 */
/* -------------------------------------------------------------------------- */

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
/* SOLANA SETUP                                                                */
/* -------------------------------------------------------------------------- */

const solanaSigner = Keypair.fromSecretKey(
  bs58.decode(process.env.SOLANA_PRIVATE_KEY!)
);

const solanaConnection = new Connection(
  clusterApiUrl("mainnet-beta"),
  "confirmed"
);

/* -------------------------------------------------------------------------- */
/* MAIN FLOW                                                                   */
/* -------------------------------------------------------------------------- */

async function aptosToSolanaSwap() {
  console.log("🚀 Starting Aptos → Solana cross-chain swap");

  /* -------------------- 1. FETCH CROSS-CHAIN QUOTE ----------------------- */
  const quote = await getCrossChainQuote({
    sourceToken: SOURCE_TOKEN,
    targetToken: TARGET_TOKEN,
    amountIn: AMOUNT_IN,
    sourceChain: NetworkId.aptos,
    targetChain: NetworkId.solana,
    slippage: SLIPPAGE,
  });

  console.log("✅ Quote fetched");

  /* -------------------- 2. DERIVE SOLANA ATA ----------------------------- */
  const usdcMint = new PublicKey(quote.targetBridgeToken);

  const ata = await deriveSolanaATA(
    usdcMint,
    solanaSigner.publicKey
  );

  console.log("🎯 Target USDC ATA:", ata.toBase58());

  /* -------------------- 3. BUILD SOURCE INSTRUCTION ---------------------- */
  const instruction = await buildCrossChainInstruction({
    quote,
    sourceAddress: aptosAccount.accountAddress.toString(),
    targetAddress: ata.toBase58(),
  });

  console.log("✅ Source instructions built");

  /* -------------------- 4. EXECUTE APTOS BURN ---------------------------- */
  const aptosTxHash = await executeAptosBurn(
    aptos,
    aptosAccount,
    instruction.bridgePayload
  );

  console.log("🔥 Burn executed on Aptos:", aptosTxHash);

  /* -------------------- 5. WAIT FOR ATTESTATION -------------------------- */
  const { messageBytes, attestationSignature } =
    await waitForAttestation({
      sourceChain: NetworkId.aptos,
      txHash: aptosTxHash,
    });

  console.log("🟢 CCTP attestation ready");

  /* -------------------- 6. CLAIM ON SOLANA (MINT USDC) ------------------- */
  const claimIx = await claimOnSolana({
    quote,
    solanaAddress: solanaSigner.publicKey.toBase58(),
    messageBytes,
    attestationSignature,
  });

  const mintSig = await executeSolanaInstruction(
    solanaConnection,
    solanaSigner,
    claimIx
  );

  console.log("🎉 USDC minted on Solana:", mintSig);

  /* -------------------- 7. TARGET SWAP (USDC → SOL) ---------------------- */
  if (!quote.targetSwapRoute) {
    console.log("🏁 No target swap required");
    return;
  }

  console.log("🔄 Executing target swap on Solana");

  const swapQuote = await getSolanaSwapQuote({
    inputToken: quote.targetSwapRoute.sourceToken,
    outputToken: TARGET_TOKEN,
    amountIn: quote.targetSwapRoute.amountIn,
    slippage: SLIPPAGE,
  });

  const swapSig = await executeSolanaSwap({
    quote: swapQuote,
    connection: solanaConnection,
    signer: solanaSigner,
  });

  console.log("🚀 Target swap complete:", swapSig);
}

/* -------------------------------------------------------------------------- */
/* RUN                                                                         */
/* -------------------------------------------------------------------------- */

aptosToSolanaSwap().catch((err) => {
  console.error("❌ Swap failed:", err);
  process.exit(1);
});
