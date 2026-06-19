// Compile-time macro: $log!("TAG", ...args)
//
//   Each arg is one of:
//     - ObjectLiteral `{ k: v, ... }`
//         Expanded: each PropertyAssignment becomes `("k=", v)`. Shorthand
//         `{ x }` becomes `("x=", x)`. Spread `{...x}` is forwarded as-is.
//     - Identifier `x`            -> auto-label "x=", value x
//     - PropertyAccess `obj.prop` -> auto-label "prop=", value obj.prop
//     - ElementAccess `obj["k"]`  -> auto-label "k=", value obj["k"]
//     - StringLiteral             -> orphan, forwarded as-is
//     - Other expressions         -> orphan, forwarded as-is
//
//   The runtime `debugLog` pairs a string ending in `=` with the next
//   value to render `key=<value>`, and prints bare strings unchanged.
//
//   Examples:
//     $log!("REPLY", requestID, status, elapsed)            // auto-labels
//     $log!("REPLY", { request_id: requestID, status })    // custom labels
//     $log!("REPLY", requestID, "outcome=missing_sdk_method") // mixed
//     $log!("REPLY", requestID, "transport=sdk_client")    // orphan inline

import { $$raw, type RawContext } from "ts-macros";

type AnyNode = any;

export function $log(tag: string, ...rest: AnyNode[]): void {
  $$raw!(
    (ctx: RawContext, tagAst: AnyNode, ...restAst: AnyNode[]): AnyNode => {
      const factory = ctx.factory;

      const emitted: AnyNode[] = [tagAst];

      for (const arg of restAst) {
        if (arg === undefined) continue;

        // Object literal: walk properties, expand each.
        if (ctx.ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            if (ctx.ts.isShorthandPropertyAssignment(prop)) {
              emitted.push(
                factory.createStringLiteral(`${prop.name.text}=`),
                factory.createIdentifier(prop.name.text),
              );
            } else if (ctx.ts.isPropertyAssignment(prop)) {
              const name = prop.name as AnyNode;
              let key: string;
              if (ctx.ts.isIdentifier(name)) key = name.text;
              else if (
                ctx.ts.isStringLiteral(name) ||
                ctx.ts.isNumericLiteral(name) ||
                ctx.ts.isNoSubstitutionTemplateLiteral(name)
              ) {
                key = name.text;
              } else {
                key = String(name.text ?? "");
              }
              emitted.push(factory.createStringLiteral(`${key}=`), prop.initializer as AnyNode);
            } else if (ctx.ts.isSpreadElement(prop)) {
              emitted.push((prop as AnyNode).expression);
            }
          }
          continue;
        }

        // Identifier: auto-label from name
        if (ctx.ts.isIdentifier(arg)) {
          emitted.push(
            factory.createStringLiteral(`${arg.text}=`),
            factory.createIdentifier(arg.text),
          );
          continue;
        }

        // PropertyAccess: auto-label from last property name
        if (ctx.ts.isPropertyAccessExpression(arg)) {
          emitted.push(
            factory.createStringLiteral(`${arg.name.text}=`),
            arg,
          );
          continue;
        }

        // ElementAccess with string key: auto-label from key
        if (ctx.ts.isElementAccessExpression(arg)) {
          const idx = arg.argumentExpression;
          if (
            idx &&
            (ctx.ts.isStringLiteral(idx) || ctx.ts.isNoSubstitutionTemplateLiteral(idx))
          ) {
            emitted.push(
              factory.createStringLiteral(`${idx.text}=`),
              arg,
            );
            continue;
          }
        }

        // Anything else (string literals, calls, ternaries, etc.):
        // forward as-is — orphan that the runtime prints unchanged.
        emitted.push(arg);
      }

      // Wrap in `void (...)` so ts-macros does not turn the macro
      // result into a `return` statement in the enclosing function.
      return factory.createVoidExpression(
        factory.createCallExpression(
          factory.createIdentifier("debugLog"),
          undefined,
          emitted,
        ),
      );
    },
  );
}
