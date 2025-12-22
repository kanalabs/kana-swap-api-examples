import axios from "axios";

export const kanaClient = axios.create({
  baseURL: "https://ag.kanalabs.io",
  timeout: 15_000,
  headers: {
    "Content-Type": "application/json",
    "X-API-KEY": process.env.KANA_API_KEY!,
  },
});
