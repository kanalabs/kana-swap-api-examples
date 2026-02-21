import axios from "axios";
import "dotenv/config";
import { KANA_API_URL, NetworkId } from "../../../constant";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type TransactionRequest,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

//Constants
const PRIVATE_KEY = "YOUR_PRIVATE_KEY";
const NODE_URI = "YOUR_NODE_URI";

export interface TransactionIX {
  to: string;
  from: string;
  value: string;
  data: string;
  gasPrice: string;
  gasLimit?: string;
  chainId: number;
  nonce?: number;
}

export interface swapIX {
  approveIX?: TransactionIX;
  swapIX?: TransactionIX;
}

const FROM_TOKEN_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TO_TOKEN_ADDRESS = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

const AMOUNT_IN = "100000000000000"; // 1 ETH

const SLIPPAGE_PERCENTAGE = 0.5;


const privateKey = PRIVATE_KEY as `0x${string}`;
const rpc = NODE_URI as string;

// Create public client for reading blockchain data
const publicClient = createPublicClient({
  chain: arbitrum,
  transport: http(rpc),
});

// Create account from private key
const account = privateKeyToAccount(privateKey);

// Create wallet client for signing transactions
const walletClient = createWalletClient({
  account,
  chain: arbitrum,
  transport: http(rpc),
});

function _increaseGasLimit(originalGasLimit: bigint): bigint {
  const increasePercentage = BigInt(10); // 10%
  const increaseAmount = (originalGasLimit * increasePercentage) / BigInt(100);
  return originalGasLimit + increaseAmount;
}

const executeEVMInstruction = async (instruction: swapIX) => {
  if (instruction.approveIX && instruction.swapIX) {
    const txParams = instruction.approveIX;

    const approveTX: TransactionRequest = {
      from: txParams.from as Address,
      to: txParams.to as Address,
      data: txParams.data as `0x${string}`,
      gasPrice: BigInt(txParams.gasPrice),
      value: BigInt(txParams.value),
    };

    // Estimate gas
    const gasEstimate = await publicClient.estimateGas({
      account: account.address,
      to: approveTX.to!,
      data: approveTX.data,
      value: approveTX.value,
    });

    const increasedGasLimit = _increaseGasLimit(gasEstimate);

    // Send approve transaction
    const approveHash = await walletClient.sendTransaction({
      to: approveTX.to!,
      data: approveTX.data,
      value: approveTX.value,
      gas: increasedGasLimit,
      gasPrice: approveTX.gasPrice,
      chain: arbitrum,
    });

    // Wait for approval transaction
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  if (instruction.swapIX) {
    const txParams = instruction.swapIX;

    const swapTX: TransactionRequest = {
      from: txParams.from as Address,
      to: txParams.to as Address,
      data: txParams.data as `0x${string}`,
      gasPrice: BigInt(txParams.gasPrice),
      value: BigInt(txParams.value),
    };

    // Estimate gas
    const gasEstimate = await publicClient.estimateGas({
      account: account.address,
      to: swapTX.to!,
      data: swapTX.data,
      value: swapTX.value,
    });

    const increasedGasLimit = _increaseGasLimit(gasEstimate);

    // Send swap transaction
    const swapHash = await walletClient.sendTransaction({
      to: swapTX.to!,
      data: swapTX.data,
      value: swapTX.value,
      gas: increasedGasLimit,
      gasPrice: swapTX.gasPrice,
      chain: arbitrum,
    });

    // Wait for swap transaction
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: swapHash,
    });

    return receipt.transactionHash;
  }
};

export const kanaswap = async () => {
  const response = await axios.get(`${KANA_API_URL}/v1/swapQuote`, {
    params: {
      inputToken: FROM_TOKEN_ADDRESS, //ETH
      outputToken: TO_TOKEN_ADDRESS, //USDC
      chain: NetworkId.Arbitrum, //Arbitrum
      amountIn: AMOUNT_IN, // amount * token decimal eg: 1*1000000000000000000
      slippage: SLIPPAGE_PERCENTAGE, //0.5%
      swapMode: "exactOut" // exactOut or exactIn, default is exactIn
    },
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": "//* YOUR API KEY *//",
    },
  });

  const data = {
    quote: response.data?.data[0],
    address: account.address,
  };

  try {
    const swapResponse = await axios.post(
      `${KANA_API_URL}/v1/swapInstruction`,
      data
    );
    const swapInstruction = await executeEVMInstruction(
      swapResponse.data?.data
    );
    console.log("Submitted transaction hash:", swapInstruction);
    return swapInstruction;
  } catch (error) {
    console.error("Error posting swap instruction:", error);
    throw error;
  }
};

kanaswap();