import React from 'react';
import { Box, Text, Heading, List, ListItem } from '@chakra-ui/react';

const FundAFaq = () => {
  return (
    <Box p={0} color="black" borderRadius="md">
      <Heading as="h2" fontSize="2xl" mb={4} color="black">
        🤫 Fund A: Frequently Asked Questions (FAQ)
      </Heading>
      
      <Heading as="h3" fontSize="lg" mb={3} color="black">
        1. What Do We Hear Most from Our LPs?
      </Heading>
      <List spacing={3} mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        <ListItem>“I want steady income and stable growth.” Yup, that’s our top focus. We run a strategy that builds ongoing cash flow (we call it ‘aloha income’) while investing in free cash flow “kings & queens” for long-term appreciation.</ListItem>
        <ListItem>“Don’t lose my money—preserve capital.” We fully agree. We prioritize risk management first. Our approach is built on controlling drawdowns. That means we won’t do reckless, high-leverage gambles.</ListItem>
        <ListItem>“Show me real numbers in the real world, not hype.” We strive for transparency. We share not just returns, but also how we achieve them. We often mention how we systematically sell puts/calls around high-quality assets—no secret sauce hidden.</ListItem>
        <ListItem>“I want flexibility but also a clear plan.” We adapt quickly if markets change, yet our foundation (selling the wall, focusing on moaty free cash flow businesses, hedging) is consistent and proven over time.</ListItem>
        <ListItem>“Let’s keep it fun and easy to understand—no unnecessary complexity.” We aim for that Apple-like simplicity: a strategy you can grasp at a glance—buy fear, sell greed, generate premium, and reinvest steadily.</ListItem>
      </List>

      <Heading as="h3" fontSize="lg" mb={3} color="black">
        2. How Do We Generate Returns (A.K.A. “Aloha Income”)?
      </Heading>
      <List spacing={3} mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        <ListItem>Selling Puts in Fearful Moments: When the market panics over a loved business (like Apple or some top free cash flow juggernaut), we sell puts—pocketing premium if fear subsides. If assigned, we buy the stock at a discount—still a win.</ListItem>
        <ListItem>Selling Calls in Greedy Moments: When markets go euphoric on a business we own, we rent out our shares by selling calls. If the rally stalls, we keep that premium. If the stock soars above our strike, we sell some shares at a nice profit.</ListItem>
        <ListItem>Reinvesting the Premium: Think of it as an “insurance float”: we get paid upfront (premium) and either keep that as pure profit or use it to buy more of the stocks we love if they dip. Over time, that compounding goes a long way.</ListItem>
      </List>

      <Heading as="h3" fontSize="lg" mb={3} color="black">
        3. Why Focus on “World-Class Free Cash Flow Companies”?
      </Heading>
      <List spacing={3} mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        <ListItem>They Survive & Thrive: In good or bad markets, a healthy FCF engine can help a company endure. We want unstoppable moats—like a check on your phone subscription, people keep paying them no matter the environment.</ListItem>
        <ListItem>They’re More Predictable: Strong FCF is a real measure of a company’s health. You can’t fake sustained cash flow. For us, that’s less stress, more reliability.</ListItem>
        <ListItem>Volatility = Opportunity: Even great companies get hammered in downturns. We swoop in by selling puts at discounted prices—turning a short-term market glitch into cash flow or cheap shares.</ListItem>
      </List>

      <Heading as="h3" fontSize="lg" mb={3} color="black">
        4. Aren’t Options Risky?
      </Heading>
      <List spacing={3} mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        <ListItem>Risk Is in the Execution: Options can be wild if misused. But we treat them like an insurance business: methodical underwriting, well-defined exposures, and collecting premium from emotional traders.</ListItem>
        <ListItem>We Only Sell on Assets We’d Happily Own: If we’re forced to buy a stock at our put strike, that’s fine. We wanted it anyway—just cheaper! Same with calls: if we’re forced to sell some shares at a set price, it’s at a profit we’re comfortable taking.</ListItem>
        <ListItem>We Hedge: We do keep tail-risk hedges—like buying cheap index puts or using diversification—so an extreme event doesn’t blow us up. It’s about being safe while we harvest premium.</ListItem>
      </List>

      <Heading as="h3" fontSize="lg" mb={3} color="black">
        5. How Do You Manage Risk & Volatility?
      </Heading>
      <List spacing={3} mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        <ListItem>Systematic, Not Emotional: We use data signals (like RSI, VIX) to gauge fear/greed. We let those signals guide our entries, so we’re not panic-trading or chasing hype.</ListItem>
        <ListItem>Position Sizing: We never put too many eggs in one basket. Each trade is sized so a worst-case scenario won’t sink the portfolio.</ListItem>
        <ListItem>Rolling & Adjusting: If a position goes against us, we might “roll” (extend the option’s timeframe, adjust strike) to reduce immediate risk. We stay flexible but never reckless.</ListItem>
        <ListItem>Ample Cash Buffers: We keep enough liquidity so we’re never forced to sell at a bad time. That’s the difference between us and many funds that blow up under margin calls.</ListItem>
      </List>

      <Heading as="h3" fontSize="lg" mb={3} color="black">
        6. Q1 2025 Recap (Quick Version)
      </Heading>
      <List spacing={3} mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        <ListItem>We outperformed most major indices, thanks to a few well-timed put sales in panic moments and call sales on big rebounds. We stayed disciplined, never chasing uncertain gambles.</ListItem>
        <ListItem>Our biggest wins came from monetizing fear spikes on top-tier companies. Our main losers were small. Net result: a steady positive quarter, while some parts of the market wobbled.</ListItem>
      </List>

      <Heading as="h3" fontSize="lg" mb={3} color="black">
        7. Q2 2025 Outlook (Short & Sweet)
      </Heading>
      <List spacing={3} mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        <ListItem>Expect More Volatility: Tariff news, new administration’s policies, inflation jitters… perfect for our “harvest volatility” approach.</ListItem>
        <ListItem>Focus on Opportunities: We anticipate fresh dips in certain moaty stocks—ripe for put-selling. We also see times to lighten up on winners by selling calls if the greed momentum resumes.</ListItem>
        <ListItem>Stay Balanced: We keep tail hedges in case the market decides to meltdown. If so, we’ll buy more of what we love at even better prices.</ListItem>
      </List>

      <Heading as="h3" fontSize="lg" mb={3} color="black">
        8. Why Does This Strategy Fit My (LP) Needs?
      </Heading>
      <List spacing={3} mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        <ListItem>Steady Income: The options premium (aloha) is a consistent revenue stream you can count on, quarter by quarter.</ListItem>
        <ListItem>Upside Potential: If the market or our best holdings shoot up, we still capture plenty of gains—especially on the portion we don’t cover with calls.</ListItem>
        <ListItem>Downside Cushion: By collecting premium, we offset some losses if markets dip. Plus, we pick up shares at discount if assigned.</ListItem>
        <ListItem>Long-Term Growth: We constantly reinvest premiums into the best free cash flow machines on the planet. Over time, that compounding is huge.</ListItem>
      </List>

      <Heading as="h3" fontSize="lg" mb={3} color="black">
        9. Any Final “Buffett-Style” Wisdom?
      </Heading>
      <List spacing={3} mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        <ListItem>“Don’t just do something, sit there.” We do less trading than many funds, but each trade is more strategic. Time is our friend, especially when we earn rent from the market’s emotional zigzags.</ListItem>
        <ListItem>“Buy fear, sell greed.” That’s the entire principle behind the “Sell the Wall” approach. We embrace it wholeheartedly—fear is an opportunity, not a reason to hide under the bed.</ListItem>
        <ListItem>“Keep a margin of safety.” We never put ourselves in a corner. Safety first, growth second. That’s how we ensure your capital thrives in all weather.</ListItem>
      </List>

      <Heading as="h3" fontSize="lg" mb={3} color="black">
        10. Key Takeaways
      </Heading>
      <List spacing={3} mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        <ListItem>We generate stable, ongoing ‘aloha income’ by systematically selling puts/calls around high-quality assets.</ListItem>
        <ListItem>We only sell puts on companies we actually love—no random dice-rolling. If we buy them via assignment, that’s a win at a discount.</ListItem>
        <ListItem>Our returns come from short-term volatility premium + long-term free cash flow compounding.</ListItem>
        <ListItem>We treat risk management like an insurer—carefully structured to avoid blow-ups.</ListItem>
        <ListItem>We stay aligned with your goals: safe, sustainable, alpha generation over time, minus the drama.</ListItem>
      </List>

      <Text mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        <strong>Important Risk Disclosures</strong>
      </Text>
      <List spacing={3} mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        <ListItem><strong>Not an Offer: </strong>This FAQ is purely informational and does not constitute an offer to sell or a solicitation to purchase any security.</ListItem>
        <ListItem><strong>Investing Involves Risk:</strong> All investment strategies carry the potential for profit and the possibility of loss. Past performance does not guarantee future results.</ListItem>
        <ListItem><strong>Options Strategy Risks:</strong> Selling puts/calls can lead to large losses if the underlying asset moves drastically against the position. While we use hedging and prudent sizing, no system can eliminate risk entirely.</ListItem>
        <ListItem><strong>Market Volatility:</strong> Market conditions can change rapidly; our references to RSI, VIX, or implied volatility signals are not crystal-ball guarantees.</ListItem>
        <ListItem><strong>SEC & Regulatory Adherence:</strong> 🤫 Fund A operates in compliance with SEC guidelines. Details about the fund’s strategies, fees, and risk factors are available in official offering documents.</ListItem>
        <ListItem><strong>Future Statements:</strong> Any forward-looking statements (like Q2 outlook) are subject to change based on economic and market developments. We assume no obligation to update them in real-time.</ListItem>
      </List>

      <Text mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        Additional Info: For more specifics on the strategy, performance details, or risk protocols, please consult our official offering memorandum or reach out to the 🤫 Fund A team. We’re always happy to chat about your concerns, but remember: no strategy is foolproof. We do everything in our power to keep it robust.
      </Text>

      <Text mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        We hope this FAQ helps clarify how and why we do what we do! We strive to keep it simple, generate the returns you desire, and preserve capital at all costs. If you have further questions, we’re one call or one text away.
      </Text>

      <Text mb={4} fontSize={{ md: "lg", base: 'sm' }}>
        Thank you,<br />
        The 🤫 Fund A Team<br />
        (On behalf of Manish Sainani, Founder)
      </Text>
    </Box>
  );
};

export default FundAFaq;
