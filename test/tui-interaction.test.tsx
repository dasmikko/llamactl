import { test, expect } from "bun:test";
import { createSignal, createMemo } from "solid-js";
import { testRender, useKeyboard } from "@opentui/solid";
import { Table } from "../src/tui/Table.tsx";
import type { Row } from "../src/tui/rows.ts";

function mkRow(i: number): Row {
  return { key:`m${i}`,modelId:`m${i}`,favoriteId:`m${i}`,groupId:"g",groupName:`M${i}`,
    name:`Model-${i}`,quant:"Q",repo:"org/repo",sizeBytes:4e9,
    model:{id:`m${i}`,name:`Model-${i}`,path:`/m${i}.gguf`,arch:"llama",kind:"text",contextLength:8192} as never,
    profiles:[],instance:undefined,running:undefined,stats:undefined,isFavorite:false };
}

test("keyboard down moves selection + scrolls the window", async () => {
  const rows = Array.from({length:11},(_,i)=>mkRow(i));
  function Nav() {
    const [selId, setSelId] = createSignal<string>("m0");
    const selIdx = createMemo(() => rows.findIndex(r => r.key === selId()));
    useKeyboard((key) => {
      if (key.name === "down" || key.sequence === "j") setSelId(rows[Math.min(selIdx()+1, rows.length-1)]!.key);
      if (key.name === "up" || key.sequence === "k") setSelId(rows[Math.max(selIdx()-1, 0)]!.key);
    });
    return <box flexDirection="column" height={12}>
      <Table title="MODELS" variant="catalog" grouped fill rows={rows} selectedIndex={selIdx()} gpuAvailable={false} now={0} width={100} maxRows={6} />
    </box>;
  }
  const { captureCharFrame, renderOnce, mockInput, flush } = await testRender(() => <Nav/>, { width: 100, height: 14 });
  await renderOnce();
  const before = captureCharFrame();
  console.log("BEFORE top rows:", Array.from({length:11},(_,i)=>`Model-${i}`).filter(n=>before.includes(n)).join(","));
  // Press down 8 times to push past the window.
  for (let i=0;i<8;i++) await mockInput.pressKeys(["ARROW_DOWN"]);
  await flush(); await renderOnce();
  const after = captureCharFrame();
  const afterVis = Array.from({length:11},(_,i)=>`Model-${i}`).filter(n=>after.includes(n));
  console.log("AFTER visible:", afterVis.join(","));
  // After scrolling down, later models (Model-8/9/10) should now be visible.
  expect(afterVis.some(n => ["Model-8","Model-9","Model-10"].includes(n))).toBe(true);
});
