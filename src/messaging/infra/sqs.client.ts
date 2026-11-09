import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";

export const QUEUE_NAME = process.env.SQS_QUEUE_NAME ?? "wager-transactions.fifo";
export const DLQ_NAME = process.env.SQS_DLQ_NAME ?? "wager-transactions-dlq.fifo";
export const EVENTS_QUEUE_NAME = process.env.SQS_EVENTS_QUEUE_NAME ?? "wagering-events.fifo";

export const sqsClient = new SQSClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint: process.env.AWS_ENDPOINT ?? "http://localhost:4566",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
});

const urls = new Map<string, string>();

/** Resolve (e memoiza) a URL da fila pelo nome. */
export async function queueUrl(name: string): Promise<string> {
  const cached = urls.get(name);
  if (cached) return cached;
  const res = await sqsClient.send(new GetQueueUrlCommand({ QueueName: name }));
  urls.set(name, res.QueueUrl!);
  return res.QueueUrl!;
}
