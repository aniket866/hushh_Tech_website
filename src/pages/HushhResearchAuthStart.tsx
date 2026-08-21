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
import { AlertTriangle } from "lucide-react";
import {
  getHushhResearchLaunchStartFailureMessage,
  startHushhResearchLaunch,
} from "../services/hushhResearch/firebaseAuth";

type StartViewState =
  | { status: "loading" }
  | { status: "error"; message: string };

interface HushhResearchAuthStartProps {
  navigateToLaunch?: (launchUrl: string) => void;
}

function navigateBrowserToLaunch(launchUrl: string) {
  window.location.assign(launchUrl);
}

const HushhResearchAuthStart: React.FC<HushhResearchAuthStartProps> = ({
  navigateToLaunch = navigateBrowserToLaunch,
}) => {
  const [attempt, setAttempt] = useState(0);
  const [viewState, setViewState] = useState<StartViewState>({
    status: "loading",
  });
  const startPromiseRef = useRef<{
    attempt: number;
    promise: ReturnType<typeof startHushhResearchLaunch>;
  } | null>(null);

  useEffect(() => {
    if (startPromiseRef.current?.attempt !== attempt) {
      startPromiseRef.current = {
        attempt,
        promise: startHushhResearchLaunch(),
      };
    }

    let active = true;
    const beginLaunch = async () => {
      const result = await startPromiseRef.current?.promise;
      if (!active || !result) {
        return;
      }

      if (!result.ok) {
        setViewState({
          status: "error",
          message: getHushhResearchLaunchStartFailureMessage(result.reason),
        });
        return;
      }

      navigateToLaunch(result.launchUrl);
    };

    void beginLaunch().catch(() => {
      if (active) {
        setViewState({
          status: "error",
          message: "Launch could not start.",
        });
      }
    });

    return () => {
      active = false;
    };
  }, [attempt, navigateToLaunch]);

  const retry = () => {
    setViewState({ status: "loading" });
    setAttempt((currentAttempt) => currentAttempt + 1);
  };

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
        {viewState.status === "loading" && (
          <Flex align="center" direction="column" py={8}>
            <Spinner
              aria-label="Opening Research"
              color="#0AADBC"
              mb={6}
              size="xl"
              speed="0.65s"
              thickness="4px"
            />
            <Heading mb={3} size="lg">
              Opening Research
            </Heading>
            <Text color="gray.600">Please wait.</Text>
          </Flex>
        )}

        {viewState.status === "error" && (
          <Flex align="center" direction="column" py={6}>
            <Icon as={AlertTriangle} color="red.500" h={16} mb={6} w={16} />
            <Heading mb={4} size="lg">
              Launch failed
            </Heading>
            <Alert mb={6} status="error">
              <AlertIcon />
              {viewState.message}
            </Alert>
            <Button colorScheme="blue" onClick={retry} size="lg">
              Try again
            </Button>
          </Flex>
        )}
      </Box>
    </Container>
  );
};

export default HushhResearchAuthStart;
