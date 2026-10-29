// In memory, per server process: enough to see actions change what pages show.
const lists = new Map<string, Array<{ title: string; by: string }>>();

export function todos(list: string) {
  return lists.get(list) ?? [];
}

export function addTodo(list: string, title: string, by: string) {
  lists.set(list, [...todos(list), { title, by }]);
}
