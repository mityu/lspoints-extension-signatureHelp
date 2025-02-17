import type { Denops } from "jsr:@denops/std@^7.1.0";
import { batch } from "jsr:@denops/std@^7.1.0/batch";
import * as fn from "jsr:@denops/std@^7.1.0/function";
import * as lambda from "jsr:@denops/std@^7.1.0/lambda";
import * as LSP from "npm:vscode-languageserver-protocol@^3.17.5";
import { BaseExtension, type Lspoints } from "jsr:@kuuote/lspoints@^0.1.1";
import { deadline } from "jsr:@std/async@^1.0.0";
import { uriFromBufnr } from "jsr:@uga-rosa/denops-lsputil@^0.9.4";
import { getCursor } from "jsr:@uga-rosa/denops-lsputil@^0.9.4/cursor";
import { assert } from "jsr:@core/unknownutil@4.3.0/assert";
import { is } from "jsr:@core/unknownutil@4.3.0/is";
import { equal } from "jsr:@std/assert@~1.0.1/equal";
import type { PredicateType } from "jsr:@core/unknownutil@4.3.0/type";
import {
  openPreviewPopup,
  type PreviewPopup,
} from "jsr:@mityu/lspoints-toolkit@^0.1.2/popup";
import {
  addHighlights,
  addTypes,
} from "jsr:@mityu/lspoints-toolkit@^0.1.2/textprop";
import { echo } from "jsr:@mityu/lspoints-toolkit@^0.1.2/echo";

const isTriggerInfo = is.UnionOf([
  is.ObjectOf({ kind: is.LiteralOf("contentChange") }),
  is.ObjectOf({
    kind: is.LiteralOf("triggerCharacter"),
    char: is.String,
    isTrigger: is.Boolean,
    isRetrigger: is.Boolean,
  }),
]);

type TriggerInfo = PredicateType<typeof isTriggerInfo>;

function getActiveParameterRange(
  signature: LSP.SignatureInformation,
  activeParameter: number,
): LSP.Range | undefined {
  if (signature.parameters) {
    const strBytesLen = (s: string) => {
      return (new TextEncoder()).encode(s).length;
    };

    const param = signature.parameters[activeParameter];
    if (is.String(param.label)) {
      const startIdx = signature.label.indexOf(param.label);
      const start = strBytesLen(signature.label.slice(0, startIdx)) + 1;
      const end = start + strBytesLen(param.label);
      return {
        start: { line: 1, character: start },
        end: { line: 1, character: end },
      };
    } else {
      const start = strBytesLen(signature.label.slice(0, param.label[0])) + 1;
      const end = strBytesLen(signature.label.slice(0, param.label[1])) + 1;
      return {
        start: { line: 1, character: start },
        end: { line: 1, character: end },
      };
    }
  } else {
    return undefined;
  }
}

async function requestSignatureHelp(
  denops: Denops,
  lspoints: Lspoints,
  bufnr: number,
  timeout: number,
  context: LSP.SignatureHelpContext,
): Promise<{ serverName: string; signatureHelp: LSP.SignatureHelp } | null> {
  const clients = lspoints.getClients(bufnr);
  if (clients.length === 0) {
    await echo(denops, `No client is attached to buffer: ${bufnr}`);
    return null;
  }
  const providerClients = clients.filter((c) => {
    return !is.Nullish(c.serverCapabilities.signatureHelpProvider);
  });
  if (providerClients.length === 0) {
    await echo(denops, `signatureHelp is not supported: ${clients[0].name}`);
    return null;
  }
  const client = providerClients[0];

  const promise = lspoints.request(
    client.name,
    "textDocument/signatureHelp",
    {
      textDocument: {
        uri: await uriFromBufnr(denops, bufnr),
      },
      position: await getCursor(denops),
      context,
    },
  ) as Promise<LSP.SignatureHelp | null>;
  const signatureHelp = await deadline(promise, timeout)
    .catch(async () => {
      await echo(denops, "signatureHelp: Request timeout");
      return null;
    });

  if (signatureHelp == null) {
    return null;
  }
  return {
    serverName: client.name,
    signatureHelp,
  };
}

export class Extension extends BaseExtension {
  #popup?: PreviewPopup;
  #lastSignatureHelp?: {
    serverName: string;
    signatureHelp: LSP.SignatureHelp;
  };
  #callbacks!: Record<"trigger" | "close", lambda.Lambda>;

  initialize(denops: Denops, lspoints: Lspoints) {
    this.#callbacks = {
      trigger: lambda.add(denops, async (info: unknown) => {
        assert(info, isTriggerInfo);
        if (info.kind == "contentChange") {
          const isRetrigger = await this.#popup?.isOpened() ?? false;
          const result = await requestSignatureHelp(
            denops,
            lspoints,
            await fn.bufnr(denops),
            5000,
            {
              triggerKind: LSP.SignatureHelpTriggerKind.ContentChange,
              isRetrigger: isRetrigger,
              activeSignatureHelp: isRetrigger
                ? this.#lastSignatureHelp?.signatureHelp
                : undefined,
            },
          );
          if (equal(result, this.#lastSignatureHelp)) {
            // Do nothing including closing popup.
            return;
          }
          await this.#popup?.close();
          this.#popup = undefined;
          if (result == null) {
            return;
          }
          this.#lastSignatureHelp = result;
          this.#showSignatureHelpOnPopup(denops, result.signatureHelp);
        } else if (info.kind == "triggerCharacter") {
          const isRetrigger = info.isRetrigger && await this.#popup?.isOpened();
          const result = await requestSignatureHelp(
            denops,
            lspoints,
            await fn.bufnr(denops),
            5000,
            {
              triggerKind: LSP.SignatureHelpTriggerKind.TriggerCharacter,
              triggerCharacter: info.char,
              isRetrigger: !!isRetrigger,
              activeSignatureHelp: isRetrigger
                ? this.#lastSignatureHelp?.signatureHelp
                : undefined,
            },
          );
          await this.#popup?.close();
          this.#popup = undefined;
          if (result == null) {
            return;
          }
          this.#lastSignatureHelp = result;
          this.#showSignatureHelpOnPopup(denops, result.signatureHelp);
        } else {
          info.kind satisfies never;
        }
      }),
      close: lambda.add(denops, async () => {
        await this.#popup?.close();
        this.#popup = undefined;
      }),
    };

    lspoints.defineCommands("signatureHelp", {
      float: async (timeout = 5000) => {
        assert(timeout, is.Number);

        const isPopupActive = await this.#popup?.isOpened();
        this.#popup?.close();
        this.#popup = undefined;

        const result = await requestSignatureHelp(
          denops,
          lspoints,
          await fn.bufnr(denops),
          timeout,
          {
            triggerKind: LSP.SignatureHelpTriggerKind.Invoked,
            isRetrigger: isPopupActive ? true : false,
            activeSignatureHelp: isPopupActive
              ? this.#lastSignatureHelp?.signatureHelp
              : undefined,
          },
        );
        if (result == null) {
          return;
        }
        this.#lastSignatureHelp = result;
        this.#showSignatureHelpOnPopup(denops, result.signatureHelp);
      },
      enableAutoFloatSignatureForBuffer: async (
        bufnrGiven = undefined,
        timeout = 5000,
      ) => {
        assert(bufnrGiven, is.UnionOf([is.Number, is.Undefined]));
        assert(timeout, is.Number);

        const bufnr = bufnrGiven ?? await fn.bufnr(denops);

        const clients = lspoints.getClients(bufnr);
        if (clients.length === 0) {
          await echo(denops, `No client is attached to buffer: ${bufnr}`);
          return null;
        }
        const providerClients = clients.filter((c) => {
          return !is.Nullish(c.serverCapabilities.signatureHelpProvider);
        });
        if (providerClients.length === 0) {
          await echo(
            denops,
            `signatureHelp is not supported: ${clients[0].name}`,
          );
          return null;
        }
        const client = providerClients[0];
        const triggerChars = client.serverCapabilities.signatureHelpProvider!
          .triggerCharacters?.join("") ?? "";
        const retriggerChars = client.serverCapabilities.signatureHelpProvider!
          .retriggerCharacters?.join("") ?? "";

        await denops.call(
          "lspoints#extension#signature_help#internal#enable_auto_float_for_buffer",
          bufnr,
          triggerChars,
          retriggerChars,
          denops.name,
          {
            trigger: this.#callbacks.trigger.id,
            close: this.#callbacks.close.id,
          },
        );
      },
    });
  }

  async #showSignatureHelpOnPopup(
    denops: Denops,
    signatureHelp: LSP.SignatureHelp,
  ) {
    if (signatureHelp.signatures.length === 0) {
      await echo(denops, "No signature information found", {
        highlight: "WarningMsg",
      });
      return;
    }

    const activeSignature = (() => {
      if (
        signatureHelp.activeSignature &&
        signatureHelp.activeSignature < signatureHelp.signatures.length
      ) {
        return signatureHelp.activeSignature;
      }
      return 0;
    })();

    const signature = signatureHelp.signatures[activeSignature];

    const activeParameter = (() => {
      const paramsLen = signature.parameters ? signature.parameters.length : 0;
      if (signature.activeParameter && signature.activeParameter < paramsLen) {
        return signature.activeParameter;
      } else if (
        signatureHelp.activeParameter &&
        signatureHelp.activeParameter < paramsLen
      ) {
        return signatureHelp.activeParameter;
      } else {
        return 0;
      }
    })();

    const activeParameterRange = getActiveParameterRange(
      signature,
      activeParameter,
    );

    await this.#popup?.close();
    this.#popup = undefined;
    this.#popup = await openPreviewPopup(denops, {
      contents: [signature.label],
      line: -1,
      col: activeParameterRange ? -activeParameterRange.start.character : 0,
      pos: "botleft",
      border: ["", "", "", " ", "", "", "", " "],
    });

    if (activeParameterRange) {
      const bufnr = this.#popup.bufnr;
      const type = "lspoints.extension.signature_help.activeparameter";
      await batch(denops, async (denops) => {
        await addTypes(denops, [{ name: type, highlight: "Type" }]);
        await addHighlights(denops, bufnr, type, [activeParameterRange]);
      });
    }

    await denops.redraw();
  }

  clientCapabilities(): LSP.ClientCapabilities {
    return {
      textDocument: {
        signatureHelp: {
          dynamicRegistration: false,
          signatureInformation: {
            documentationFormat: [
              LSP.MarkupKind.Markdown,
              LSP.MarkupKind.PlainText,
            ],
            parameterInformation: {
              labelOffsetSupport: true,
            },
            activeParameterSupport: true,
          },
          contextSupport: true,
        },
      },
    };
  }
}
