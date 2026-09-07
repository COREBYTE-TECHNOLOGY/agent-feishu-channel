import { describe, it, expect } from "vitest";
import { translateReceiveEvent, type FeishuImageClient } from "../../../src/feishu/message-translator.js";
import { createLogger } from "../../../src/util/logger.js";
import type { ReceiveV1Event } from "../../../src/feishu/types.js";
import { parseInput } from "../../../src/commands/router.js";

const SILENT = createLogger({ level: "error", pretty: false });

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function makeEvent(msgType: string, content: unknown): ReceiveV1Event {
  return {
    sender: { sender_id: { open_id: "ou_sender" } },
    message: {
      message_id: "om_test",
      chat_id: "oc_test",
      message_type: msgType,
      content: typeof content === "string" ? content : JSON.stringify(content),
      create_time: "1700000000000",
    },
  } as ReceiveV1Event;
}

function fakeClient(map: Record<string, Buffer>): FeishuImageClient {
  return {
    async downloadImage(_msgId: string, key: string): Promise<Buffer> {
      const bytes = map[key];
      if (!bytes) throw new Error(`no fixture for ${key}`);
      return bytes;
    },
  };
}

describe("translateReceiveEvent — post messages", () => {
  it("accepts a post with text + 2 images, sniffing each MIME", async () => {
    const event = makeEvent("post", {
      content: [[
        { tag: "text", text: "screenshots: " },
        { tag: "img", image_key: "img_a" },
        { tag: "img", image_key: "img_b" },
      ]],
    });
    const client = fakeClient({ img_a: PNG_BYTES, img_b: JPEG_BYTES });
    const result = await translateReceiveEvent(event, client, SILENT);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("screenshots:");
    expect(result!.imageDataUris).toHaveLength(2);
    expect(result!.imageDataUris![0]).toMatch(/^data:image\/png;base64,/);
    expect(result!.imageDataUris![1]).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("accepts a post with only text (no imageDataUris field)", async () => {
    const event = makeEvent("post", {
      content: [[{ tag: "text", text: "hello" }]],
    });
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("hello");
    expect(result!.imageDataUris).toBeUndefined();
  });

  it("drops the message when ANY post image fails to download", async () => {
    const event = makeEvent("post", {
      content: [[
        { tag: "img", image_key: "img_ok" },
        { tag: "img", image_key: "img_boom" },
      ]],
    });
    const client = fakeClient({ img_ok: PNG_BYTES }); // img_boom missing
    const result = await translateReceiveEvent(event, client, SILENT);
    expect(result).toBeNull();
  });

  it("drops the message when post content is not valid JSON", async () => {
    const event = makeEvent("post", "{not json");
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result).toBeNull();
  });

  it("drops the message when post content array is missing", async () => {
    const event = makeEvent("post", { title: "x" });
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result).toBeNull();
  });

  it("drops an empty post (no text, no images)", async () => {
    const event = makeEvent("post", { content: [[]] });
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result).toBeNull();
  });
});

describe("translateReceiveEvent — regression for existing branches", () => {
  it("forwards text messages unchanged", async () => {
    const event = makeEvent("text", { text: "ping" });
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result).toEqual(expect.objectContaining({
      text: "ping",
      messageId: "om_test",
      chatId: "oc_test",
      senderOpenId: "ou_sender",
    }));
    expect(result!.imageDataUris).toBeUndefined();
  });

  it("sniffs MIME for the standalone image branch too (PNG, not hardcoded JPEG)", async () => {
    const event = makeEvent("image", { image_key: "img_one" });
    const client = fakeClient({ img_one: PNG_BYTES });
    const result = await translateReceiveEvent(event, client, SILENT);
    expect(result!.imageDataUris).toHaveLength(1);
    expect(result!.imageDataUris![0]).toMatch(/^data:image\/png;base64,/);
    expect(result!.text).toBe("[Image]");
  });

  it("drops unsupported message types (file, audio, etc.) with an info log", async () => {
    const event = makeEvent("file", { file_key: "f_1" });
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result).toBeNull();
  });

  it("drops image message with missing image_key", async () => {
    const event = makeEvent("image", {});
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result).toBeNull();
  });
});

describe("translateReceiveEvent — @mention stripping (COREBYTE hardening)", () => {
  function mentionEvent(
    text: string,
    mentions?: ReceiveV1Event["message"]["mentions"],
  ): ReceiveV1Event {
    const event = makeEvent("text", { text });
    if (mentions) event.message.mentions = mentions;
    return event;
  }

  const CLAUDE = [
    { key: "@_user_1", id: { open_id: "ou_claude_bot" }, name: "corebyte-claude" },
  ];

  it("strips the mention so a command reaches the router intact", async () => {
    const result = await translateReceiveEvent(
      mentionEvent("@_user_1 /stop", CLAUDE),
      fakeClient({}),
      SILENT,
    );
    expect(result!.text).toBe("/stop");
    expect(parseInput(result!.text)).toEqual({ kind: "stop" });
  });

  it("keeps plain text intact after the mention", async () => {
    const result = await translateReceiveEvent(
      mentionEvent("@_user_1 看下这个 PR", CLAUDE),
      fakeClient({}),
      SILENT,
    );
    expect(result!.text).toBe("看下这个 PR");
    expect(parseInput(result!.text)).toEqual({
      kind: "run",
      text: "看下这个 PR",
    });
  });

  it("strips several mentions and @_all", async () => {
    const result = await translateReceiveEvent(
      mentionEvent("@_all @_user_1 @_user_2 /status", [
        { key: "@_all", name: "all" },
        ...CLAUDE,
        { key: "@_user_2", id: { open_id: "ou_codex_bot" }, name: "corebyte-codex" },
      ]),
      fakeClient({}),
      SILENT,
    );
    expect(result!.text).toBe("/status");
  });

  it("still strips placeholders when the mentions array is absent", async () => {
    const result = await translateReceiveEvent(
      mentionEvent("@_user_1 !urgent"),
      fakeClient({}),
      SILENT,
    );
    expect(result!.text).toBe("!urgent");
  });

  it("strips mentions from post messages too", async () => {
    const event = makeEvent("post", {
      content: [[{ tag: "text", text: "@_user_1 /help" }]],
    });
    event.message.mentions = CLAUDE;
    const result = await translateReceiveEvent(event, fakeClient({}), SILENT);
    expect(result!.text).toBe("/help");
  });
});

describe("translateReceiveEvent — rich-text stop regression (#47)", () => {
  const bot = "ou_codex_bot";
  const mentions = [{
    key: "@_user_1", id: { open_id: bot, user_id: "bot_user", union_id: "bot_union" },
    name: "corebyte-codex",
  }];

  function post(elements: unknown[], withMentions = true): ReceiveV1Event {
    const event = makeEvent("post", { content: [elements] });
    if (withMentions) event.message.mentions = mentions;
    return event;
  }

  it.each([bot, "@_user_1", "bot_user", "bot_union"])(
    "routes a structural bot mention (%s) plus code-styled /stop without a model turn",
    async (userId) => {
      const event = post([
        { tag: "at", user_id: userId, user_name: "corebyte-codex" },
        { tag: "text", text: " /stop", style: ["code"] },
      ]);
      const result = await translateReceiveEvent(event, fakeClient({}), SILENT, bot);
      expect(result!.text).toBe("/stop");
      expect(parseInput(result!.text)).toEqual({ kind: "stop" });
    },
  );

  it("handles a direct own open_id without mention metadata or display name", async () => {
    const result = await translateReceiveEvent(post([
      { tag: "at", user_id: bot }, { tag: "text", text: " /STOP  " },
    ], false), fakeClient({}), SILENT, bot);
    expect(parseInput(result!.text)).toEqual({ kind: "stop" });
  });

  it.each([
    { tag: "at", user_id: "ou_other", user_name: "corebyte-codex" },
    { tag: "at", user_name: "corebyte-codex" },
    { tag: "text", text: "@corebyte-codex" },
  ])("does not promote a name-only or body-text reference into a stop command (%j)", async (element) => {
    const result = await translateReceiveEvent(post([
      element, { tag: "text", text: " /stop" },
    ]), fakeClient({}), SILENT, bot);
    expect(result!.text).toBe("@corebyte-codex /stop");
    expect(parseInput(result!.text).kind).toBe("run");
  });

  it("does not remove a structural mention without a resolved own identity", async () => {
    const result = await translateReceiveEvent(post([
      { tag: "at", user_id: bot, user_name: "corebyte-codex" },
      { tag: "text", text: " /stop" },
    ]), fakeClient({}), SILENT);
    expect(parseInput(result!.text).kind).toBe("run");
  });

  it("keeps other structural mentions, images and body references", async () => {
    const result = await translateReceiveEvent(post([
      { tag: "at", user_id: bot },
      { tag: "text", text: " ask " },
      { tag: "at", user_id: "ou_simon", user_name: "Simonchen" },
      { tag: "text", text: " about @corebyte-codex" },
      { tag: "img", image_key: "img_a" },
    ]), fakeClient({ img_a: PNG_BYTES }), SILENT, bot);
    expect(result!.text).toBe("ask @Simonchen about @corebyte-codex");
    expect(result!.imageDataUris).toHaveLength(1);
  });

  it("does not concatenate command fragments around an omitted mention", async () => {
    const result = await translateReceiveEvent(post([
      { tag: "text", text: "/st" }, { tag: "at", user_id: bot },
      { tag: "text", text: "op" },
    ]), fakeClient({}), SILENT, bot);
    expect(result!.text).toBe("/st op");
    expect(parseInput(result!.text).kind).not.toBe("stop");
  });
});
