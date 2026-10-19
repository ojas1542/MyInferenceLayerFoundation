export type Attachment = {
  id: string;
  name: string;
  size: number;
  content: string;
};

export type Stats = {
  promptTokens: number;
  completionTokens: number;
  // Generation speed as measured by llama-server; absent for cache hits.
  tokensPerSecond?: number;
  cached: boolean;
  similarity?: number;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  attachments?: Attachment[];
  stats?: Stats;
  error?: string;
  pending?: boolean;
  stopped?: boolean;
  createdAt: number;
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
};
