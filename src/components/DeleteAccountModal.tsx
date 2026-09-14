import { useRef, useState } from "react";
import { useToast } from "@chakra-ui/react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import config from "../resources/config/config";
import { useAuthSession } from "../auth/AuthSessionProvider";
import { useModalKeyboardNavigation } from "../hooks/useModalKeyboardNavigation";
import { AppleLineIcon, appleFont } from "./hushh-tech-ui/HushhAppleUI";

interface DeleteAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccountDeleted: () => void;
}

/**
 * Delete Account Modal — Apple-style destructive confirmation surface.
 * Backend logic is preserved — only UI is redesigned.
 */
const DeleteAccountModal = ({
  isOpen,
  onClose,
  onAccountDeleted,
}: DeleteAccountModalProps) => {
  const { t } = useTranslation();
  const toast = useToast();
  const { session, revalidateSession, handleAccountDeleted } = useAuthSession();
  const [confirmText, setConfirmText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const confirmInputRef = useRef<HTMLInputElement>(null);

  const isDeleteEnabled = confirmText.toUpperCase() === "DELETE";

  // =====================================================
  // Backend logic
  // =====================================================
  const handleDeleteAccount = async () => {
    if (!isDeleteEnabled) return;

    setIsDeleting(true);

    try {
      console.log("[DeleteAccount] Starting account deletion process...");

      let accessToken: string | null = session?.access_token || null;

      // Try refreshing session via GCP client if available
      if (config.gcpBackendClient) {
        try {
          const { data: refreshData, error: refreshError } =
            await config.gcpBackendClient.auth.refreshSession();
          if (!refreshError && refreshData?.session?.access_token) {
            accessToken = refreshData.session.access_token;
            console.log("[DeleteAccount] Session refreshed successfully");
          }
        } catch (err) {
          console.warn("[DeleteAccount] Session refresh warning, falling back to current session:", err);
        }
      }

      // Revalidate if still missing access token
      if (!accessToken) {
        const snapshot = await revalidateSession();
        if (snapshot.status === "authenticated" && snapshot.session?.access_token) {
          accessToken = snapshot.session.access_token;
        }
      }

      if (!accessToken) {
        throw new Error(
          "Session expired or invalid. Please log out and log in again to delete your account."
        );
      }

      console.log("[DeleteAccount] Calling delete endpoint...");
      const response = await fetch("/api/delete-account", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success !== true) {
        console.error("[DeleteAccount] Delete API error:", data);
        const errMsg = data?.error || data?.details || "Failed to delete account";
        throw new Error(typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg));
      }

      console.log("[DeleteAccount] Account deleted successfully", data);
      await handleAccountDeleted();

      toast({
        title: t("deleteAccount.successTitle", "Account Deleted"),
        description: t("deleteAccount.successMessage", "Your account and data have been removed."),
        status: "success",
        duration: 5000,
        isClosable: true,
      });

      setTimeout(() => {
        onAccountDeleted();
      }, 500);
    } catch (error: any) {
      console.error("[DeleteAccount] Error:", error);
      toast({
        title: t("deleteAccount.errorTitle", "Deletion Failed"),
        description: error.message || t("deleteAccount.errorMessage", "Failed to delete account"),
        status: "error",
        duration: 5000,
        isClosable: true,
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleClose = () => {
    setConfirmText("");
    onClose();
  };

  useModalKeyboardNavigation({
    isOpen,
    containerRef: modalRef,
    initialFocusRef: confirmInputRef,
    onClose: handleClose,
  });

  if (!isOpen) return null;

  // =====================================================
  // Apple-style destructive modal
  // =====================================================
  return (
    <>
      {/* ── Frosted glass overlay ── */}
      <div
        className="fixed inset-0 z-40 bg-[#000000]/35 backdrop-blur-[14px]"
        onClick={handleClose}
      />

      {/* ── Modal card — bottom-sheet on mobile, centered on desktop ── */}
      <div className="fixed inset-0 z-50 flex items-end justify-center px-4 pb-6 sm:items-center sm:pb-0">
        <div
          ref={modalRef}
          className="relative flex w-full max-w-[390px] flex-col items-center rounded-[28px] border border-[#1D1D1F]/[0.06] bg-white p-6 text-center shadow-[0_28px_70px_rgba(0,0,0,0.22)] sm:p-7"
          style={{ fontFamily: appleFont }}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-account-title"
          tabIndex={-1}
        >
          {/* ── Warning icon in circle ── */}
          <div className="mb-6">
            <AppleLineIcon icon={Trash2} size={64} />
          </div>

          {/* ── Heading & description ── */}
          <div className="mb-7 space-y-3 px-1">
            <p className="text-[11px] font-medium uppercase leading-tight tracking-[1.6px] text-[#FF3B30]/85">
              Delete Account
            </p>
            <h2
              id="delete-account-title"
              className="text-[28px] font-medium leading-[1.06] tracking-[-0.028em] text-[#1D1D1F] sm:text-[32px]"
            >
              Are you sure?
            </h2>
            <p className="mx-auto max-w-[320px] text-[13px] font-light leading-[1.45] text-[#1D1D1F]/60">
              This permanently deletes your profile, onboarding, Plaid,
              chats, NDA, KYC, and stored files. Only a minimal de-identified
              payment audit may remain for compliance.
            </p>
          </div>

          {/* ── Confirmation input ── */}
          <div className="mb-7 w-full">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-[1.6px] text-[#1D1D1F]/50">
              Type DELETE to confirm
            </p>
            <input
              ref={confirmInputRef}
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
              placeholder="DELETE"
              className="h-[52px] w-full rounded-[16px] border border-[#1D1D1F]/10 bg-[#F5F5F7] px-4 text-center font-mono text-[14px] tracking-[2px] text-[#1D1D1F] outline-none transition placeholder:text-[#1D1D1F]/25 focus:border-[#1D1D1F]/35 focus:bg-white focus:ring-1 focus:ring-[#1D1D1F]/20"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Type DELETE to confirm account deletion"
            />
          </div>

          {/* ── Action buttons ── */}
          <div className="w-full space-y-3">
            {/* Delete — primary black */}
            <button
              onClick={handleDeleteAccount}
              disabled={!isDeleteEnabled || isDeleting}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[#FF3B30] text-[15px] font-medium text-white transition hover:bg-[#E6352B] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-35"
            >
              {isDeleting ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  <span>Deleting...</span>
                </>
              ) : (
                <>
                  <Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
                  <span>Delete my account</span>
                </>
              )}
            </button>

            {/* Keep — outlined white */}
            <button
              onClick={handleClose}
              disabled={isDeleting}
              className="h-12 w-full rounded-full border border-[#1D1D1F]/15 bg-white text-[15px] font-medium text-[#1D1D1F] transition hover:bg-[#F5F5F7] active:scale-[0.99] disabled:opacity-50"
            >
              Keep my account
            </button>

            {/* Cancel — text link */}
            <div className="pt-2">
              <button
                onClick={handleClose}
                disabled={isDeleting}
                className="text-[12px] font-medium text-[#1D1D1F]/45 transition hover:text-[#1D1D1F] disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default DeleteAccountModal;
