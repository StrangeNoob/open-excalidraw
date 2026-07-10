import { useNavigate } from "react-router-dom";

import { DEFAULT_GUEST_DRAWING_ID } from "../model";
import { GuestMigrationCloudClient, GuestMigrationService } from "../services";
import { GuestRepository } from "../storage";
import { GuestMigrationPrompt } from "./GuestMigrationPrompt";

const migrationService = new GuestMigrationService(
  new GuestRepository(),
  new GuestMigrationCloudClient(),
);

export interface AuthenticatedGuestMigrationPromptProps {
  userId: string;
}

export const AuthenticatedGuestMigrationPrompt = ({
  userId,
}: AuthenticatedGuestMigrationPromptProps) => {
  const navigate = useNavigate();

  return (
    <GuestMigrationPrompt
      drawingId={DEFAULT_GUEST_DRAWING_ID}
      onMigrated={(drawingId) => {
        void navigate(`/drawings/${drawingId}`);
      }}
      service={migrationService}
      userId={userId}
    />
  );
};
