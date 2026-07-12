import { MainMenu, WelcomeScreen } from "@excalidraw/excalidraw";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";

import {
  accountIcon,
  CanvasStatusFooter,
  ExcalidrawHost,
  signInIcon,
} from "../../editor";
import {
  DEFAULT_GUEST_DRAWING_ID,
  DEFAULT_GUEST_DRAWING_TITLE,
} from "../model";
import {
  useGuestCanvas,
  type GuestCanvasRepository,
} from "../hooks/useGuestCanvas";

const SIGN_IN_PATH = "/login?returnTo=%2Fapp";
const SIGN_UP_PATH = "/signup?returnTo=%2Fapp";

export interface GuestCanvasPageProps {
  drawingId?: string;
  repository?: GuestCanvasRepository;
  saveDelayMs?: number;
  title?: string;
}

const EXCALIDRAW_DEFAULT_BACKGROUND = "#ffffff";

/**
 * A transparent scene lets the app's dotted paper show through the canvas, so
 * the guest page reads like the rest of the product. Excalidraw's own white
 * default is autosaved before a guest ever opens the background picker, so it
 * is treated as "unset"; any other colour is a real choice and is kept.
 */
const paperBackground = (saved: string | undefined) =>
  !saved || saved === EXCALIDRAW_DEFAULT_BACKGROUND ? "transparent" : saved;

const saveStatusLabel = (status: string) => {
  switch (status) {
    case "saving":
      return "Saving locally…";
    case "saved":
      return "Saved on this device";
    case "error":
      return "Local save failed";
    default:
      return "Changes stay on this device";
  }
};

export const GuestCanvasPage = ({
  drawingId = DEFAULT_GUEST_DRAWING_ID,
  repository,
  saveDelayMs,
  title = DEFAULT_GUEST_DRAWING_TITLE,
}: GuestCanvasPageProps) => {
  const navigate = useNavigate();
  const guest = useGuestCanvas({
    drawingId,
    repository,
    saveDelayMs,
    title,
  });

  const initialData = useMemo(
    () => ({
      ...guest.initialData,
      appState: {
        ...guest.initialData?.appState,
        viewBackgroundColor: paperBackground(
          guest.initialData?.appState?.viewBackgroundColor,
        ),
      },
    }),
    [guest.initialData],
  );

  if (guest.status === "loading") {
    return (
      <main className="canvas-page canvas-page--centered">
        <p aria-live="polite">Loading your local drawing…</p>
      </main>
    );
  }

  if (guest.initialLoadFailed) {
    return (
      <main className="canvas-page canvas-page--centered">
        <section className="canvas-message" role="alert">
          <strong>Could not open this local drawing.</strong>
          <span>{guest.error?.message}</span>
        </section>
      </main>
    );
  }

  return (
    <main className="canvas-page">
      <ExcalidrawHost
        initialData={initialData}
        onChange={guest.onChange}
        renderTopRightUI={() => (
          <div className="canvas-top-right">
            <button
              className="canvas-action"
              onClick={() => void navigate(SIGN_IN_PATH)}
              type="button"
            >
              Sign in
            </button>
            <button
              className="canvas-action canvas-action--primary"
              onClick={() => void navigate(SIGN_UP_PATH)}
              type="button"
            >
              Create account
            </button>
          </div>
        )}
        title={title}
      >
        <MainMenu>
          <MainMenu.Item
            icon={accountIcon}
            onSelect={() => void navigate(SIGN_UP_PATH)}
          >
            Create account
          </MainMenu.Item>
          <MainMenu.Item
            icon={signInIcon}
            onSelect={() => void navigate(SIGN_IN_PATH)}
          >
            Sign in
          </MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Export />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
        </MainMenu>

        <WelcomeScreen>
          <WelcomeScreen.Hints.MenuHint>
            Export, canvas background, help…
          </WelcomeScreen.Hints.MenuHint>
          <WelcomeScreen.Hints.ToolbarHint>
            Pick a tool & start drawing!
          </WelcomeScreen.Hints.ToolbarHint>
          <WelcomeScreen.Hints.HelpHint />

          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Logo>
              <span className="canvas-wordmark">Open Excalidraw</span>
            </WelcomeScreen.Center.Logo>
            <WelcomeScreen.Center.Heading>
              This drawing is saved on this device only.
              <br />
              Create an account to keep it safe and draw with others.
            </WelcomeScreen.Center.Heading>
            <WelcomeScreen.Center.Menu>
              <WelcomeScreen.Center.MenuItem
                icon={accountIcon}
                onSelect={() => void navigate(SIGN_UP_PATH)}
                shortcut={null}
              >
                Create an account
              </WelcomeScreen.Center.MenuItem>
              <WelcomeScreen.Center.MenuItem
                icon={signInIcon}
                onSelect={() => void navigate(SIGN_IN_PATH)}
                shortcut={null}
              >
                Sign in
              </WelcomeScreen.Center.MenuItem>
              <WelcomeScreen.Center.MenuItemLoadScene />
              <WelcomeScreen.Center.MenuItemHelp />
            </WelcomeScreen.Center.Menu>
          </WelcomeScreen.Center>
        </WelcomeScreen>

        <CanvasStatusFooter
          label={saveStatusLabel(guest.status)}
          tone={guest.status === "error" ? "error" : "muted"}
        />
      </ExcalidrawHost>
    </main>
  );
};
