import { Counter, Typed } from "../components/counter";
import { Later, OnClick } from "../components/later";
import { Panel } from "../components/panel";
import { Document } from "../document";

export default async function Home() {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return (
    <Document title="islx">
      <h1>islx on Vite</h1>
      <Counter start={1} label="first" />
      <Counter start={10} label="second" />
      <Typed
        at={new Date("2026-10-29T00:00:00.000Z")}
        stock={new Map([["apples", 3]])}
        id={9007199254740993n}
      />
      <Panel title="toggle">
        <p data-testid="server-child">rendered on the server</p>
      </Panel>
      <OnClick />
      <div style={{ height: "3000px" }} />
      <Later />
    </Document>
  );
}
