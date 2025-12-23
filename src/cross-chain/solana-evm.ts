/**
 * Solana (SOL) → Avalanche (AVAX)
 * Flow:
 * 1. Source Swap: SOL → USDC (using sourceSwapRoute from Quote)
 * 2. Bridge: USDC → USDC (via CCTP)
 * 3. Claim: Mint USDC on Avalanche
 * 4. Target Swap: USDC → AVAX (using targetSwapRoute logic)
 */

import axios from "axios";
import "dotenv/config";

import {
  Connection,
  Keypair,
  VersionedTransaction,
  clusterApiUrl,
  PublicKey,
} from "@solana/web3.js";

import { ethers } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";
import bs58 from "bs58";

import { KANA_API_URL, NetworkId } from "../constant";

/* -------------------------------------------------------------------------- */
/* CONFIG                                    */
/* -------------------------------------------------------------------------- */

const SOURCE_TOKEN = "So11111111111111111111111111111111111111112"; // SOL
const TARGET_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // AVAX

const AMOUNT_IN = "10000000"; // 0.01 SOL
const SLIPPAGE = 1.0; 

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* --------------------------- SETUP ---------------------------------------- */

// Solana
const solanaConnection = new Connection(
  process.env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta"),
  "confirmed"
);
const solanaSigner = Keypair.fromSecretKey(
  bs58.decode(process.env.SOLANA_PRIVATE_KEY!)
);

// Avalanche
const avaxProvider = new ethers.providers.JsonRpcProvider(
  process.env.AVALANCHE_RPC_URL!
);
const avaxSigner = new ethers.Wallet(
  process.env.EVM_PRIVATE_KEY!,
  avaxProvider
);

/* -------------------------------------------------------------------------- */
/* MAIN FLOW                                   */
/* -------------------------------------------------------------------------- */

async function solanaToAvalancheFlow() {
  console.log("🚀 Starting Flow: SOL (Solana) -> AVAX (Avalanche)");

  /* -------------------- 1. FETCH CROSS-CHAIN QUOTE ----------------------- */
  const quoteRes = await axios.get(`${KANA_API_URL}/v1/crossChainQuote`, {
    params: {
      sourceToken: SOURCE_TOKEN,
      targetToken: TARGET_TOKEN,
      sourceChain: NetworkId.solana,
      targetChain: NetworkId.Avalanche,
      amountIn: AMOUNT_IN,
      sourceSlippage: SLIPPAGE,
      targetSlippage: SLIPPAGE,
    },
    headers,
  });

  const quote = quoteRes.data.data[0];
  console.log("✅ Quote fetched");

  /* -------------------- 2. SOURCE SWAP (SOL -> USDC) --------------------- */
  let bridgedAmount = quote.inAmount; // Default if no swap needed

  if (quote.sourceSwapRoute) {
    console.log("🔄 Executing Source Swap (SOL -> USDC)...");
    
    // We use the route details directly from the cross-chain quote
    const swapTxRes = await axios.post(
      `${KANA_API_URL}/v1/swapInstruction`,
      {
        quote: quote.sourceSwapRoute,
        address: solanaSigner.publicKey.toBase58(),
      },
      { headers }
    );
    const swapSig = await executeSolanaTx(
      solanaConnection,
      solanaSigner,
      swapTxRes.data.data.swapTransaction
    );
    
    console.log("✅ Source Swap Complete! Tx:", swapSig);
    
    // Update amount for the bridge step
    bridgedAmount = quote.sourceSwapRoute.amountOutWithSlippage;
    
    console.log("⏳ Waiting 5s for balance sync...");
    await new Promise(r => setTimeout(r, 5000));
  }

  /* -------------------- 3. BRIDGE (USDC -> USDC) ------------------------- */
  console.log("🌉 Initiating Bridge (USDC -> USDC)...");

  const bridgeQuoteRes = await axios.get(`${KANA_API_URL}/v1/crossChainQuote`, {
    params: {
      sourceToken: quote.sourceBridgeToken, // USDC (EPj...)
      targetToken: quote.targetBridgeToken, // USDC (0xB97...)
      sourceChain: NetworkId.solana,
      targetChain: NetworkId.Avalanche,
      amountIn: bridgedAmount, 
      sourceSlippage: SLIPPAGE,
      targetSlippage: SLIPPAGE,
    },
    headers,
  });
  
  const bridgeQuote = bridgeQuoteRes.data.data[0];

  const transferRes = await axios.post(
    `${KANA_API_URL}/v1/crossChainTransfer`,
    {
      quote: bridgeQuote,
      sourceAddress: solanaSigner.publicKey.toBase58(),
      targetAddress: await avaxSigner.getAddress(),
    },
    { headers }
  );

  const burnTxHash = await executeSolanaTx(
    solanaConnection,
    solanaSigner,
    transferRes.data.data.transferTx
  );
  console.log("🔥 Burn FINALIZED on Solana:", burnTxHash);

  /* -------------------- 4. WAIT FOR ATTESTATION -------------------------- */
  console.log("⏳ Polling for CCTP Attestation...");
  const { messageBytes, attestationSignature } =
    await waitForCctpAttestation(burnTxHash);

  console.log("🟢 CCTP Attestation Ready!");

  /* -------------------- 5. CLAIM (MINT USDC) ----------------------------- */
  console.log("📥 Claiming USDC on Avalanche...");
  
  const claimRes = await axios.post(
    `${KANA_API_URL}/v1/claim`,
    {
      quote: bridgeQuote,
      targetAddress: await avaxSigner.getAddress(),
      messageBytes,
      attestationSignature,
    },
    { headers }
  );

  const claimIx = claimRes.data.data.claimIx;
  
  const mintTx = await avaxSigner.sendTransaction({
    to: claimIx.to,
    data: claimIx.data,
    value: BigNumber.from(claimIx.value || 0),
  });

  const mintReceipt = await mintTx.wait();
  console.log("🎉 USDC Minted on Avalanche:", mintReceipt.transactionHash);

  console.log("⏳ Waiting 3s for EVM sync...");
  await new Promise(r => setTimeout(r, 3000));

  /* -------------------- 6. TARGET SWAP (USDC -> AVAX) -------------------- */
  if (quote.targetSwapRoute) {
    console.log("🔄 Executing Target Swap (USDC -> AVAX)...");
    
    const avaxSwapQuoteRes = await axios.get(`${KANA_API_URL}/v1/swapQuote`, {
      params: {
        inputToken: quote.targetSwapRoute.sourceToken, // USDC
        outputToken: quote.targetSwapRoute.targetToken, // AVAX
        chain: NetworkId.Avalanche,
        amountIn: bridgeQuote.outAmount,
        slippage: SLIPPAGE,
      },
      headers,
    });

    const avaxSwapQuote = avaxSwapQuoteRes.data.data[0];

    const avaxSwapTxRes = await axios.post(
      `${KANA_API_URL}/v1/swapInstruction`,
      {
        quote: avaxSwapQuote,
        address: await avaxSigner.getAddress(),
      },
      { headers }
    );

    const swapInstruction = avaxSwapTxRes.data.data;

    const swapHash = await executeTargetEVMInstruction(avaxSigner, swapInstruction);
    console.log("🚀 FINAL SUCCESS! Swapped to AVAX. Hash:", swapHash);
  } else {
    console.log("🏁 No target swap required.");
  }
}

solanaToAvalancheFlow().catch(console.error);

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

async function executeSolanaTx(
  connection: Connection,
  signer: Keypair,
  base64Tx: string
): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, "base64"));
  tx.sign([signer]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  console.log("⏳ Sent Solana Tx:", sig);

  const latest = await connection.getLatestBlockhash("confirmed");
  const status = await connection.confirmTransaction(
    { signature: sig, ...latest },
    "finalized"
  );

  if (status.value.err) throw new Error("Transaction failed");
  return sig;
}

async function forceApprove(
    signer: ethers.Wallet, 
    tokenAddress: string, 
    spender: string, 
    amount: any
) {
    console.log(`🛡️  Checking Approval for ${tokenAddress}...`);
    const abi = ["function approve(address spender, uint256 amount) public returns (bool)"];
    const tokenContract = new ethers.Contract(tokenAddress, abi, signer);
    try {
        const tx = await tokenContract.approve(spender, amount);
        console.log("⏳ Sending Approval...");
        await tx.wait();
        console.log("✅ Approved:", tx.hash);
    } catch (e: any) {
        console.log("⚠️ Approval check skipped/failed:", e.message);
    }
}

async function executeTargetEVMInstruction(signer: ethers.Wallet, instruction: any) {
  
  if (instruction.approveIX) {
    const txParams = instruction.approveIX;
    console.log(`🛡️  Approving Token... Spender: ${txParams.to}`);

    const approveTX: ethers.providers.TransactionRequest & { gasLimit?: string } = {
      from: txParams.from,
      to: txParams.to,
      data: txParams.data,
      chainId: txParams.chainId,
      gasPrice: txParams.gasPrice ? BigNumber.from(txParams.gasPrice).toHexString() : undefined,
      value: BigNumber.from(txParams.value || 0).toHexString(),
    };

    try {
        const gasLimit = await signer.estimateGas(approveTX);
        approveTX["gasLimit"] = gasLimit.mul(110).div(100).toHexString();
    } catch (e) {
        console.log("⚠️ Gas estimation for approval failed, using fallback.");
        approveTX["gasLimit"] = ethers.utils.hexlify(150000); 
    }

    const tx = await signer.sendTransaction(approveTX);
    console.log("⏳ Sending Approval...");
    await tx.wait();
    console.log("✅ Approval Confirmed:", tx.hash);
  }

  if (instruction.swapIX) {
    const txParams = instruction.swapIX;
    console.log("⏳ Sending Swap Tx...");

    const swapTX: ethers.providers.TransactionRequest & { gasLimit?: string } = {
      from: txParams.from,
      to: txParams.to,
      data: txParams.data,
      chainId: txParams.chainId,
      gasPrice: txParams.gasPrice ? BigNumber.from(txParams.gasPrice).toHexString() : undefined,
      value: BigNumber.from(txParams.value || 0).toHexString(),
    };

    swapTX["gasLimit"] = ethers.utils.hexlify(1000000); 
    console.log(JSON.stringify(swapTX, null, 2));
    const tx = await signer.sendTransaction(swapTX);
    const receipt = await tx.wait();
    return receipt.transactionHash;
  }
  
  throw new Error("No swap instructions found in API response");
}

/* ---------------------- CCTP ATTESTATION POLLING -------------------------- */
const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";

async function waitForCctpAttestation(txHash: string) {
  const cctpChainId = 5; // Solana
  while (true) {
    try {
        const res = await fetch(`${CIRCLE_ATTESTATION_API}/messages/${cctpChainId}/${txHash}`);
        const json = await res.json();
        const msg = json?.messages?.[0];
        if (msg && msg.attestation !== "PENDING") {
            return { messageBytes: msg.message, attestationSignature: msg.attestation };
        }
    } catch(e) {}
    await new Promise((r) => setTimeout(r, 5000));
  }
}