import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Container,
  Flex,
  Heading,
  Icon,
  Spinner,
  Text,
} from "@chakra-ui/react";
import { AlertTriangle, CheckCircle } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuthSession } from "../auth/AuthSessionProvider";
import { canHushhResearchAccessRoute } from "../auth/routePolicy";
import {
  HUSHH_RESEARCH_CALLBACK_PATH,
  HUSHH_RESEARCH_SOURCE,
} from "../services/hushhResearch/contracts";
import {
  completeHushhResearchLaunch,
  getHushhResearchLaunchFailureMessage,
} from "../services/hushhResearch/firebaseAuth";
import { sanitizeInternalRedirect } from "../utils/security";

type CallbackViewState =
  | { status: "loading" }
  | { status: "success" }
  | { status: "error"; message: string };

const HushhResearchAuthCallback: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { revalidateSession, signOut } = useAuthSession();
  const [viewState, setViewState] = useState<CallbackViewState>({
    status: "loading",
  });
  const launchPromiseRef = useRef<{
    key: string;
    promise: ReturnType<typeof completeHushhResearchLaunch>;
  } | null>(null);

  const code = searchParams.get("code") || "";
  const state = searchParams.get("state") || "";
  const source = searchParams.get("source");
  const hasValidCallbackInput =
    Boolean(code.trim()) &&
    Boolean(state.trim()) &&
    source === HUSHH_RESEARCH_SOURCE;
  const requestedRedirectTarget = sanitizeInternalRedirect(
    searchParams.get("redirect"),
    "/"
  );
  const redirectTarget = canHushhResearchAccessRoute(
    requestedRedirectTarget,
  )
    ? requestedRedirectTarget
    : "/";

  useEffect(() => {
    if (!hasValidCallbackInput) {
      void signOut();
      return;
    }

    const callbackKey = `${code}\u0000${state}\u0000${source}`;
    if (launchPromiseRef.current?.key !== callbackKey) {
      launchPromiseRef.current = {
        key: callbackKey,
        promise: completeHushhResearchLaunch({
          code,
          state,
          source: HUSHH_RESEARCH_SOURCE,
        }),
      };
    }

    let active = true;
    const finishLaunch = async () => {
      const result = await launchPromiseRef.current?.promise;
      if (!active || !result) {
        return;
      }

      if (!result.ok) {
        await signOut();
        if (!active) {
          return;
        }
        setViewState({
          status: "error",
          message: getHushhResearchLaunchFailureMessage(result.reason),
        });
        return;
      }

      const sessionSnapshot = await revalidateSession();
      if (
        !active ||
        sessionSnapshot.status !== "authenticated" ||
        sessionSnapshot.user?.id !== result.uid
      ) {
        await signOut();
        if (active) {
          setViewState({
            status: "error",
            message: "Sign-in could not finish.",
          });
        }
        return;
      }

      window.history.replaceState(
        {},
        document.title,
        HUSHH_RESEARCH_CALLBACK_PATH
      );
      setViewState({ status: "success" });
      navigate(redirectTarget, { replace: true });
    };

    void finishLaunch().catch(async () => {
      if (active) {
        await signOut();
      }
      if (active) {
        setViewState({
          status: "error",
          message: "Sign-in could not finish.",
        });
      }
    });

    return () => {
      active = false;
    };
  }, [
    code,
    hasValidCallbackInput,
    navigate,
    redirectTarget,
    revalidateSession,
    signOut,
    source,
    state,
  ]);

  const renderedViewState: CallbackViewState = hasValidCallbackInput
    ? viewState
    : { status: "error", message: "Open a new link." };

  return (
    <Container maxW="container.sm" px={{ base: 4, md: 6 }} py={{ base: 8, md: 12 }}>
      <Box
        bg="white"
        borderRadius="lg"
        borderWidth="1px"
        boxShadow="lg"
        p={{ base: 6, md: 8 }}
        textAlign="center"
      >
        {renderedViewState.status === "loading" && (
          <Flex align="center" direction="column" py={8}>
            <Spinner
              aria-label="Signing in"
              color="#0AADBC"
              mb={6}
              size="xl"
              speed="0.65s"
              thickness="4px"
            />
            <Heading mb={3} size="lg">
              Signing you in
            </Heading>
            <Text color="gray.600">Please wait.</Text>
          </Flex>
        )}

        {renderedViewState.status === "success" && (
          <Flex align="center" direction="column" py={6} role="status">
            <Icon as={CheckCircle} color="green.500" h={16} mb={6} w={16} />
            <Heading mb={3} size="lg">
              Signed in
            </Heading>
            <Text color="gray.600">Opening HushhTech.</Text>
          </Flex>
        )}

        {renderedViewState.status === "error" && (
          <Flex align="center" direction="column" py={6}>
            <Icon as={AlertTriangle} color="red.500" h={16} mb={6} w={16} />
            <Heading mb={4} size="lg">
              Sign-in failed
            </Heading>
            <Alert mb={6} status="error">
              <AlertIcon />
              {renderedViewState.message}
            </Alert>
            <Button colorScheme="blue" onClick={() => navigate("/")} size="lg">
              Go home
            </Button>
          </Flex>
        )}
      </Box>
    </Container>
  );
};

export default HushhResearchAuthCallback;
