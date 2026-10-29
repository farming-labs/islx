import { addToInbox } from "../actions";
import { Clicks, Rename, Votes } from "../components/votes";
import { addTodo, todos } from "../db";
import { Document } from "../document";

export default async function Todos() {
  const list = "groceries";
  const owner = { name: "Ada", since: new Date("2026-01-01T00:00:00.000Z") };

  async function addItem(form: FormData) {
    "use server";
    addTodo(list, String(form.get("title") ?? ""), owner.name);
  }

  async function vote(previous: { votes: number }, form: FormData) {
    "use server";
    return { votes: previous.votes + Number(form.get("by") ?? 1) };
  }

  const rename = async (title: string) => {
    "use server";
    return `${owner.name} renamed ${list} ${title}`;
  };

  return (
    <Document title="todos">
      <h1>Todos</h1>
      <form action={addItem}>
        <input name="title" data-testid="title" />
        <button data-testid="add">Add</button>
      </form>
      <ul data-testid="items">
        {todos(list).map((item, index) => (
          <li key={index}>
            {item.title} by {item.by}
          </li>
        ))}
      </ul>
      <form action={addToInbox}>
        <input name="title" data-testid="inbox-title" />
        <button data-testid="inbox-add">Inbox</button>
      </form>
      <ul data-testid="inbox">
        {todos("inbox").map((item, index) => (
          <li key={index}>{item.title}</li>
        ))}
      </ul>
      <Clicks />
      <Votes vote={vote} />
      <Rename rename={rename} />
    </Document>
  );
}
