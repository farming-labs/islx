import { Like } from "../components/like";
import { Document } from "../document";

// Every island here waits for a click, so the page starts with the boot script alone.
export default async function Quiet() {
  return (
    <Document title="quiet">
      <h1>Quiet</h1>
      <Like />
    </Document>
  );
}
