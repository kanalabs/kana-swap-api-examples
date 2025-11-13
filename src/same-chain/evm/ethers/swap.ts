import axios from "axios";
import "dotenv/config";
import { KANA_API_URL, NetworkId } from "../../../constant";
import { BigNumber, ethers } from "ethers";

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
const TO_TOKEN_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const AMOUNT_IN = "1000000000000000000"; // 1 MATIC

const SLIPPAGE_PERCENTAGE = 0.5;

const evmExchange = ["okx"];

const privateKey = PRIVATE_KEY as string;
const rpc = NODE_URI as string;
const provider = ethers.getDefaultProvider(rpc);
const signer = new ethers.Wallet(privateKey, provider);

function _increaseGasLimit(originalGasLimit: number): number {
  const increasePercentage = 0.1;
  const increaseAmount = originalGasLimit * increasePercentage;
  const increasedGasLimit = Math.ceil(originalGasLimit + increaseAmount);
  return increasedGasLimit;
}
const executeEVMInstruction = async (signer: any, instruction: swapIX) => {
  if (instruction.approveIX && instruction.swapIX) {
    const txParams = instruction.approveIX;
    const approveTX: TransactionIX = {
      from: txParams.from,
      to: txParams.to,
      data: txParams.data,
      chainId: txParams.chainId,
      gasPrice: BigNumber.from(txParams.gasPrice).toHexString(),
      value: BigNumber.from(txParams.value).toHexString(),
    };

    const gasLimit = await signer.estimateGas(approveTX);
    const increasedGasLimit = _increaseGasLimit(gasLimit.toNumber());

    approveTX.gasLimit = increasedGasLimit.toString();

    const tx = await signer.sendTransaction(approveTX);
    await tx.wait();
  }

  if (instruction.swapIX) {
    const txParams = instruction.swapIX;

    const swapTX: TransactionIX = {
      from: txParams.from,
      to: txParams.to,
      data: txParams.data,
      chainId: txParams.chainId,
      gasPrice: BigNumber.from(txParams.gasPrice).toHexString(),
      value: BigNumber.from(txParams.value).toHexString(),
    };

    const gasLimit = await signer.estimateGas(swapTX);
    const increasedGasLimit = _increaseGasLimit(gasLimit.toNumber());
    swapTX.gasLimit = increasedGasLimit.toString();
    const tx = await signer.sendTransaction(swapTX);
    const reciept = await tx.wait();

    return reciept.transactionHash;
  }
};
export const kanaswap = async () => {
  const response = await axios.get(`${KANA_API_URL}/v1/swapQuote`, {
    params: {
      inputToken: FROM_TOKEN_ADDRESS, //MATIC
      outputToken: TO_TOKEN_ADDRESS, //USDC
      chain: NetworkId.polygon, //Polygon
      amountIn: AMOUNT_IN, // amonut * token decimal eg: 1*1000000000000000000
      slippage: SLIPPAGE_PERCENTAGE, //0.5%
      evmExchange: JSON.stringify(evmExchange),
    },
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": "//* YOUR API KEY *//",
    },
  });
  const data = {
    quote: response.data?.data[0],
    address: signer.address,
  };

  try {
    const response = await axios.post(
      `${KANA_API_URL}/v1/swapInstruction`,
      data
    );
    const swapInstruction = await executeEVMInstruction(
      signer,
      response.data?.data
    );
    console.log("Submitted transaction hash:", swapInstruction);
    return swapInstruction;
  } catch (error) {
    console.error("Error posting swap instruction:", error);
    throw error;
  }
};

kanaswap();
