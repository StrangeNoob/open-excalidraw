import { DisabledMailer } from "../src/disabled.js";

describe("DisabledMailer", () => {
  it("returns the manual-action status without requiring a transport", async () => {
    const mailer = new DisabledMailer();

    await expect(
      mailer.send({
        to: "person@example.com",
        subject: "Invitation",
        text: "Copy the link",
        html: "<p>Copy the link</p>",
      }),
    ).resolves.toEqual({
      status: "disabled",
      manualActionRequired: true,
    });
  });
});
