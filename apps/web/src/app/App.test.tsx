import { render, screen } from "@testing-library/react";

import { App } from "./App";

describe("App", () => {
  it("renders the workspace shell", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Open Excalidraw" }),
    ).toBeInTheDocument();
  });
});
