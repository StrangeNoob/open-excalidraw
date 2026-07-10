import { render, screen } from "@testing-library/react";

import { getDrawingCapabilities } from "./capabilities";
import { ViewerBanner } from "./ViewerBanner";

describe("drawing capabilities", () => {
  it.each([
    ["owner", true, true, true],
    ["editor", true, true, false],
    ["viewer", false, false, false],
  ] as const)(
    "maps the %s role without falling through",
    (role, editScene, renameDrawing, deleteDrawing) => {
      expect(getDrawingCapabilities(role)).toMatchObject({
        deleteDrawing,
        editScene,
        renameDrawing,
      });
    },
  );

  it("explains viewer access", () => {
    render(<ViewerBanner ownerName="Ada" />);

    expect(screen.getByRole("status")).toHaveTextContent("View only");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Ada shared this drawing with you as a viewer.",
    );
  });
});
