"use server";
import { addTodo } from "./db";

export async function addToInbox(form: FormData) {
  addTodo("inbox", String(form.get("title") ?? ""), "inbox form");
}
