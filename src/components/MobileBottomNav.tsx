// src/components/MobileBottomNav.tsx
// Mobile bottom navigation with 4 tabs matching the exact design reference
// Active tab has blue circular background behind icon
// Issue #1219: Fixed overlay issues and added entrance animation

import React from 'react';
import { Box, Flex, Text, Icon } from '@chakra-ui/react';
import { Link, useLocation } from 'react-router-dom';
import { FiHome, FiTrendingUp, FiUsers, FiUser } from 'react-icons/fi';
import { motion } from 'framer-motion';
import { useInvestorJourneyCta } from '../hooks/useInvestorJourneyCta';
import { useChromeVisibility } from '../hooks/useChromeVisibility';

const MotionLink = motion(Link);

interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
  path: string;
  matchPaths?: string[]; // Additional paths that should highlight this tab
}

const navItems: NavItem[] = [
  {
    id: 'home',
    label: 'Home',
    icon: FiHome,
    path: '/',
    matchPaths: [],
  },
  {
    id: 'fund',
    label: 'Fund A',
    icon: FiTrendingUp,
    path: '/discover-fund-a',
    matchPaths: ['/sell-the-wall', '/ai-powered-berkshire'],
  },
  {
    id: 'community',
    label: 'Community',
    icon: FiUsers,
    path: '/community',
    matchPaths: [],
  },
  {
    id: 'profile',
    label: 'Profile',
    icon: FiUser,
    path: '/hushh-user-profile',
    matchPaths: [],
  },
];

// Pages where bottom nav should be hidden
const hiddenOnPages = [
  '/onboarding',
  '/login',
  '/signup',
  '/auth',
  '/hushh-user-profile', // Hide nav on profile page for better UX (like onboarding)
];

// Framer Motion variants for entrance animation
const navVariants = {
  // First paint only.
  hidden: {
    y: 20,
    opacity: 0,
  },
  visible: {
    y: 0,
    opacity: 1,
    transition: {
      type: 'spring',
      stiffness: 300,
      damping: 30,
    },
  },
  // Scrolled away, or on a route that excludes the bar. Fully off-screen rather than faded, so
  // nothing shows through the content underneath it.
  tucked: {
    y: '100%',
    opacity: 1,
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 40,
    },
  },
};

// Motion component for the nav container
const MotionBox = motion(Box);

interface MobileBottomNavProps {
  /**
   * Layout-level suppression. The layout used to express this by not rendering the bar at all,
   * which is a mount/unmount across every navigation between a suppressed and an unsuppressed
   * route. Passing it in keeps the bar mounted and lets it hide itself.
   */
  suppressed?: boolean;
}

const MobileBottomNav: React.FC<MobileBottomNavProps> = ({ suppressed = false }) => {
  const location = useLocation();
  // For unpaid users the Profile tab now routes via the journey hook (which
  // takes them to step-9 / FL with a banner) instead of dumping them on
  // /hushh-user-profile only to be evicted by InvestorAccessRoute. This
  // removes the flash-then-bounce UX on the mobile tab bar.
  const { primaryCTA: journeyCta } = useInvestorJourneyCta();
  const scrolledAway = useChromeVisibility();

  // Check if current page should hide the nav
  const shouldHideNav = hiddenOnPages.some(page =>
    location.pathname.toLowerCase().startsWith(page.toLowerCase())
  );

  // Check if we're on a full-screen community post
  const isFullScreenPost = location.pathname.startsWith('/community/') &&
    location.pathname !== '/community';

  // Deliberately NOT an early `return null`. Unmounting the bar on these routes and remounting it
  // on the next one replays the entrance spring every time, which is the flicker readers noticed.
  // It stays mounted for the life of the session and slides out of the way instead.
  const routeHidesNav = suppressed || shouldHideNav || isFullScreenPost;

  // Check if a nav item is active - uses location.pathname for immediate sync
  const checkIsActive = (item: NavItem): boolean => {
    if (location.pathname === item.path) return true;
    if (item.matchPaths?.some(p => location.pathname.startsWith(p))) return true;
    // Special case for community - match any /community path
    if (item.id === 'community' && location.pathname.startsWith('/community')) return true;
    return false;
  };

  return (
    <>
      <Box
        aria-hidden="true"
        display={{ base: 'block', md: 'none' }}
        h={
          routeHidesNav
            ? '0px'
            : { base: 'calc(92px + env(safe-area-inset-bottom, 0px))', sm: 'calc(108px + env(safe-area-inset-bottom, 0px))' }
        }
        flexShrink={0}
      />
      <MotionBox
        as="nav"
        role="navigation"
        aria-label="Mobile bottom navigation"
        display={{ base: 'block', md: 'none' }}
        position="fixed"
        bottom="0"
        left="0"
        right="0"
        zIndex="1000"
        bg="#F8F9FA"
        borderTop="1px solid"
        borderColor="#E5E7EB"
        // Ensure nav doesn't block content - use pointer-events properly
        css={{
          // Prevent the nav background from extending beyond its bounds
          clipPath: 'inset(0 0 0 0)',
        }}
        // The entrance plays once, on first mount. There is no `key` here on purpose: keying this
        // by pathname made React discard and rebuild the whole bar on every navigation, replaying
        // the spring and its staggered children each time.
        variants={navVariants}
        initial="hidden"
        animate={routeHidesNav || scrolledAway ? 'tucked' : 'visible'}
        aria-hidden={routeHidesNav ? true : undefined}
        sx={{
          pb: 'env(safe-area-inset-bottom, 0px)',
          // `visibility` keeps a route-excluded bar out of the tab order. It is not used for the
          // scroll tuck, which must stay focusable for anyone tabbing rather than scrolling.
          visibility: routeHidesNav ? 'hidden' : 'visible',
        }}
      >
        <Flex
          justify="space-around"
          align="center"
          h={{ base: '70px', sm: '85px' }}
          maxW="448px"
          mx="auto"
          px="2"
          // Ensure consistent height on all viewports
          css={{
            minHeight: '70px',
          }}
        >
          {navItems.map((item) => {
            const active = checkIsActive(item);
            const isProfileTab = item.id === 'profile';
            const shouldInterceptProfile =
              isProfileTab && !journeyCta.loading && !journeyCta.isInvestor;
            const handleProfileIntercept = (event: React.MouseEvent) => {
              if (!shouldInterceptProfile) return;
              event.preventDefault();
              journeyCta.action();
            };
            return (
              <Flex
                as={MotionLink}
                to={item.path}
                onClick={isProfileTab ? handleProfileIntercept : undefined}
                key={item.id}
                direction="column"
                align="center"
                justify="center"
                gap="1"
                p="2"
                flex="1"
                h="100%"
                transition="all 0.2s ease"
                role="link"
                aria-current={active ? 'page' : undefined}
                _active={{ transform: 'scale(0.95)' }}
                _focusVisible={{
                  outline: 'none',
                  bg: 'rgba(47, 128, 237, 0.05)',
                  borderRadius: 'lg',
                }}
              >
                {/* Icon Container - Blue circle when active */}
                <Flex
                  align="center"
                  justify="center"
                  w="48px"
                  h="48px"
                  borderRadius="full"
                  bg={active ? '#E8F0FE' : 'transparent'}
                  transition="all 0.2s ease"
                >
                  <Icon
                    as={item.icon}
                    boxSize={6}
                    color={active ? '#2F80ED' : '#9CA3AF'}
                    strokeWidth={active ? 2.5 : 2}
                    transition="all 0.2s ease"
                  />
                </Flex>

                {/* Label */}
                <Text
                  fontSize="11px"
                  fontWeight={active ? '600' : '500'}
                  color={active ? '#2F80ED' : '#9CA3AF'}
                  letterSpacing="0.01em"
                  transition="all 0.2s ease"
                  mt="-2px"
                >
                  {item.label}
                </Text>
              </Flex>
            );
          })}
        </Flex>
      </MotionBox>
    </>
  );
};

export default MobileBottomNav;
