import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef } from "react";

import "./excalidraw-host.css";

export type ExcalidrawChangeHandler = NonNullable<ExcalidrawProps["onChange"]>;
export type ExcalidrawPointerHandler = NonNullable<
  ExcalidrawProps["onPointerUpdate"]
>;
export type ExcalidrawInitialData = ExcalidrawInitialDataState | null;
export type ExcalidrawInitialDataSource = ExcalidrawProps["initialData"];

export interface ExcalidrawHostProps {
  initialData?: ExcalidrawInitialDataSource;
  isCollaborating?: boolean;
  onApiChange?: (api: ExcalidrawImperativeAPI | null) => void;
  onChange?: ExcalidrawChangeHandler;
  onPointerUpdate?: ExcalidrawPointerHandler;
  readOnly?: boolean;
  title: string;
}

export const ExcalidrawHost = ({
  initialData,
  isCollaborating = false,
  onApiChange,
  onChange,
  onPointerUpdate,
  readOnly = false,
  title,
}: ExcalidrawHostProps) => {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const apiChangeCallbackRef = useRef(onApiChange);
  const previousApiChangeCallbackRef = useRef(onApiChange);

  const captureApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    apiChangeCallbackRef.current?.(api);
  }, []);

  useEffect(() => {
    apiChangeCallbackRef.current = onApiChange;

    if (
      apiRef.current &&
      previousApiChangeCallbackRef.current !== onApiChange
    ) {
      onApiChange?.(apiRef.current);
    }

    previousApiChangeCallbackRef.current = onApiChange;
  }, [onApiChange]);

  useEffect(
    () => () => {
      apiRef.current = null;
      apiChangeCallbackRef.current?.(null);
    },
    [],
  );

  useEffect(() => {
    const api = apiRef.current;

    if (api && api.getName() !== title) {
      api.updateScene({
        appState: { name: title },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  }, [title]);

  return (
    <section
      aria-label={`${title} drawing canvas`}
      className="excalidraw-host"
      data-read-only={readOnly}
      style={{ height: "100%", minHeight: 360, width: "100%" }}
    >
      <Excalidraw
        excalidrawAPI={captureApi}
        initialData={initialData}
        isCollaborating={isCollaborating}
        name={title}
        onChange={onChange}
        onPointerUpdate={onPointerUpdate}
        viewModeEnabled={readOnly}
      />
    </section>
  );
};
