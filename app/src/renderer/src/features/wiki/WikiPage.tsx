import React, { type JSX } from "react";
import { WikiEditor } from "./WikiEditor";
export function WikiPage(props: Parameters<typeof WikiEditor>[0]): JSX.Element { return <section><h1>家谱百科</h1><WikiEditor {...props} /></section>; }
