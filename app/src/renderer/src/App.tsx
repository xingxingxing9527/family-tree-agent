import React, { type JSX } from "react";
import { AppRouter } from "./app/AppRouter";
import { ErrorBoundary } from "./app/ErrorBoundary";

export default function App(): JSX.Element {
  return <ErrorBoundary><AppRouter /></ErrorBoundary>;
}
