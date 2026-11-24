/** The props every renderer's counter takes: typed values the codec carries to the browser. */
export interface CounterProps {
  label: string;
  start: number;
  since: Date;
  tags: Map<string, number>;
}

/** A renderer's server side: the page's one-time bootstrap and its string renderer. */
export interface ServerRenderer {
  /** The module's export the island names. */
  export: string;
  /** Markup the page needs once, in its head. */
  head?: string;
  render(props: CounterProps, id: string): string | Promise<string>;
}

/** The island modules a page's client entry can import, by the `src` the server wrote. */
export function moduleLoader(modules: Record<string, () => Promise<Record<string, unknown>>>) {
  return (src: string) => {
    const load = modules[src];
    if (!load) throw new Error(`No island module is registered for ${src}`);
    return load();
  };
}
