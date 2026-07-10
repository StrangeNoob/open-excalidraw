export interface ViewerBannerProps {
  ownerName?: string;
}

export const ViewerBanner = ({ ownerName }: ViewerBannerProps) => (
  <aside aria-label="View-only access" className="viewer-banner" role="status">
    <strong>View only</strong>
    <span>
      {ownerName
        ? `${ownerName} shared this drawing with you as a viewer.`
        : "You can explore this drawing, but you cannot change it."}
    </span>
  </aside>
);
