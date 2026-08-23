import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Container,
  Box,
  Text,
  Alert,
  AlertIcon,
  AlertTitle,
  AlertDescription,
  Button,
  HStack,
} from '@chakra-ui/react';
import LoadingSpinner from '../../components/LoadingSpinner';
import ReportDetail from '../../components/ReportDetail';
import { getReportById, Report } from '../../services/reportService';
import { useAuthSession } from '../../auth/AuthSessionProvider';
import { HUSHH_RESEARCH_SOURCE } from '../../services/hushhResearch/contracts';
import { isHushhResearchAuthMode } from '../../services/hushhResearch/firebaseAuth';

const ReportDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { session } = useAuthSession();
  const isResearchBoundary =
    isHushhResearchAuthMode() ||
    session?.user?.app_metadata?.auth_source === HUSHH_RESEARCH_SOURCE;

  const renderRecoveryActions = () => (
    <HStack spacing={3} mt={4} justifyContent="center" flexWrap="wrap">
      <Button
        type="button"
        colorScheme="cyan"
        variant="outline"
        onClick={() => navigate('/community')}
      >
        Back to Community
      </Button>
      <Button type="button" variant="ghost" onClick={() => navigate('/')}>
        Back to Home
      </Button>
    </HStack>
  );

  useEffect(() => {
    const fetchReport = async () => {
      if (!id) {
        setError('Report ID is missing');
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      
      try {
        console.log('Fetching report with ID:', id);
        const reportData = await getReportById(id, {
          researchBoundary: isResearchBoundary,
        });
        
        if (reportData) {
          console.log('Fetched report:', reportData);
          setReport(reportData);
        } else {
          setError('The requested report could not be found');
          console.error('Report not found:', id);
        }
      } catch (error) {
        console.error('Error fetching report:', error);
        setError('Failed to load the report. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    fetchReport();
  }, [id, isResearchBoundary]);

  // Render content based on state
  const renderContent = () => {
    if (loading) {
      return (
        <Box textAlign="center" py={8}>
          <LoadingSpinner size="lg" label="Loading report" />
        </Box>
      );
    }

    if (error) {
      return (
        <Alert
          status="error"
          variant="subtle"
          role="alert"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          textAlign="center"
          borderRadius="md"
          py={6}
        >
          <AlertIcon boxSize="40px" mr={0} />
          <AlertTitle mt={4} mb={1} fontSize="lg">
            Error Loading Report
          </AlertTitle>
          <AlertDescription maxWidth="sm">
            {error}
          </AlertDescription>
          {renderRecoveryActions()}
        </Alert>
      );
    }

    if (!report) {
      return (
        <Alert
          status="info"
          variant="subtle"
          role="alert"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          textAlign="center"
          borderRadius="md"
          py={6}
        >
          <AlertIcon boxSize="40px" mr={0} />
          <AlertTitle mt={4} mb={1} fontSize="lg">
            Report Not Found
          </AlertTitle>
          <AlertDescription maxWidth="sm">
            We couldn't find the report you're looking for.
          </AlertDescription>
          {renderRecoveryActions()}
        </Alert>
      );
    }

    return <ReportDetail report={report} isLoading={false} />;
  };

  return (
    <Box as="main" id="main-content" bg="white" minH="100vh" py={12} px={4}>
      <Container maxW="container.md">
        <Text as="p" fontSize={{ base: 'sm', md: 'md' }} fontWeight="600" color="#0AADBC" mb={4}>
          Market Updates
        </Text>
        
        {renderContent()}
        
        {/* <Text fontSize={'sm'} my={{md:'3rem',base:'1.5rem'}}>
          © 2025 Hushh Technologies LLC. All Rights Reserved. The materials on this website are for illustration and discussion purposes only and do not constitute an offering. An offering may be made only by delivery of a confidential offering memorandum to appropriate investors. PAST PERFORMANCE IS NO GUARANTEE OF FUTURE RESULTS. 
        </Text> */}
      </Container>
    </Box>
  );
};

export default ReportDetailPage;
