import { createFileRoute } from "@tanstack/react-router";
import { Counter } from "../components/counter";
import { Quote } from "../components/quote";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const Route = createFileRoute("/stream")({
  // Not awaited: the page streams, and the quote follows when it resolves.
  loader: () => ({
    quote: wait(800).then(() => ({
      text: "Streamed from the loader",
      at: new Date("2026-11-01T00:00:00.000Z"),
    })),
  }),
  component: StreamPage,
});

function StreamPage() {
  const { quote } = Route.useLoaderData();
  return (
    <section>
      <h1>Stream</h1>
      <Counter start={0} label="Early" />
      <Quote quote={quote} />
    </section>
  );
}
