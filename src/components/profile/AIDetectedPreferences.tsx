/**
 * AI-Detected Preferences Component
 * Displays preferences detected from AI-powered web intelligence
 * User can edit and confirm these preferences before they're saved to their profile
 */

import React, { useEffect, useState } from 'react';
import { 
  Sparkles, 
  Edit2, 
  Check, 
  X, 
  ChevronDown,
  ChevronUp,
  Coffee,
  Utensils,
  Music,
  Film,
  Plane,
  Heart,
  Palette,
  Laptop,
  TrendingUp,
  Users,
  Book,
  Car,
  Loader2
} from 'lucide-react';
import config from '../../resources/config/config';
import { PREFERENCE_FIELD_LABELS, ProfilePreferences } from '../../services/profileSearch/types';

interface EnrichedProfile {
  age?: number;
  dob?: string;
  occupation?: string;
  nationality?: string;
  address?: {
    line1?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
  };
  phone?: {
    countryCode?: string;
    number?: string;
  };
  preferences?: ProfilePreferences;
  confidence: number;
  net_worth_score: number;
  field_sources?: Record<string, string>;
  updated_at?: string;
}

interface AIDetectedPreferencesProps {
  userId: string;
  onSave?: (updatedPreferences: ProfilePreferences) => void;
}

// Map preference categories to icons
const categoryIcons: Record<string, React.ReactNode> = {
  // Food & Drink
  diet: <Utensils className="w-4 h-4" />,
  foods: <Utensils className="w-4 h-4" />,
  coffeePreferences: <Coffee className="w-4 h-4" />,
  chaiPreferences: <Coffee className="w-4 h-4" />,
  drinkPreferences: <Coffee className="w-4 h-4" />,
  diningStyle: <Utensils className="w-4 h-4" />,
  restaurantTypes: <Utensils className="w-4 h-4" />,
  
  // Entertainment
  musicGenres: <Music className="w-4 h-4" />,
  musicArtists: <Music className="w-4 h-4" />,
  musicPlatform: <Music className="w-4 h-4" />,
  streamingServices: <Film className="w-4 h-4" />,
  movieGenres: <Film className="w-4 h-4" />,
  showsWatching: <Film className="w-4 h-4" />,
  
  // Travel
  hotelPreferences: <Plane className="w-4 h-4" />,
  travelStyle: <Plane className="w-4 h-4" />,
  travelDestinations: <Plane className="w-4 h-4" />,
  travelFrequency: <Plane className="w-4 h-4" />,
  
  // Lifestyle
  hobbies: <Heart className="w-4 h-4" />,
  colors: <Palette className="w-4 h-4" />,
  fashionStyle: <Palette className="w-4 h-4" />,
  fashionBrands: <Palette className="w-4 h-4" />,
  
  // Tech
  brands: <Laptop className="w-4 h-4" />,
  techEcosystem: <Laptop className="w-4 h-4" />,
  smartDevices: <Laptop className="w-4 h-4" />,
  aiPreferences: <Laptop className="w-4 h-4" />,
  
  // Financial
  investmentStyle: <TrendingUp className="w-4 h-4" />,
  shoppingBehavior: <TrendingUp className="w-4 h-4" />,
  paymentPreference: <TrendingUp className="w-4 h-4" />,
  
  // Social
  socialPersonality: <Users className="w-4 h-4" />,
  socialMediaUsage: <Users className="w-4 h-4" />,
  petPreference: <Heart className="w-4 h-4" />,
  pets: <Heart className="w-4 h-4" />,
  
  // Learning
  bookGenres: <Book className="w-4 h-4" />,
  newsSources: <Book className="w-4 h-4" />,
  podcasts: <Book className="w-4 h-4" />,
  
  // Transport
  vehiclePreference: <Car className="w-4 h-4" />,
  transportMode: <Car className="w-4 h-4" />,
};

// Group preferences by category
const preferenceCategories: Record<string, string[]> = {
  'Food & Drink': ['diet', 'foods', 'coffeePreferences', 'chaiPreferences', 'drinkPreferences', 'spiciness', 'diningStyle', 'restaurantTypes', 'deliveryApps'],
  'Entertainment': ['musicGenres', 'musicArtists', 'musicPlatform', 'streamingServices', 'movieGenres', 'showsWatching', 'gamingPlatform'],
  'Travel & Hotels': ['hotelPreferences', 'travelStyle', 'travelDestinations', 'travelFrequency'],
  'Lifestyle': ['hobbies', 'colors', 'likes', 'dislikes', 'fashionStyle', 'fashionBrands', 'smokePreferences'],
  'Health & Fitness': ['fitnessRoutine', 'healthApps', 'sleepPattern', 'allergies', 'healthInsurance', 'meditationPractice'],
  'Work & Productivity': ['workEnvironment', 'productivityTools', 'workHours', 'communicationPreference', 'learningStyle'],
  'Tech': ['brands', 'techEcosystem', 'smartDevices', 'aiPreferences'],
  'Financial': ['investmentStyle', 'shoppingBehavior', 'paymentPreference'],
  'Social': ['socialPersonality', 'socialMediaUsage', 'contentCreation', 'petPreference', 'pets'],
  'Learning': ['bookGenres', 'newsSources', 'podcasts'],
  'Transport': ['vehiclePreference', 'transportMode'],
  'Beliefs': ['spiritualBeliefs'],
};

const toCategoryId = (category: string) =>
  category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const AIDetectedPreferences: React.FC<AIDetectedPreferencesProps> = ({ userId, onSave }) => {
  const [enrichedProfile, setEnrichedProfile] = useState<EnrichedProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['Food & Drink', 'Tech', 'Lifestyle']));
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [saving, setSaving] = useState(false);

  // Fetch enriched profile on mount
  useEffect(() => {
    const fetchEnrichedProfile = async () => {
      try {
        const gcpBackend = config.gcpBackendClient;
        if (!gcpBackend || !userId) return;

        const { data, error: fetchError } = await gcpBackend
          .from('user_enriched_profiles')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle();

        if (fetchError) {
          if (fetchError.code === 'PGRST116') {
            // No profile found - not an error, just empty
            setEnrichedProfile(null);
          } else {
            throw fetchError;
          }
        } else {
          setEnrichedProfile(data);
        }
      } catch (err) {
        console.error('[AIDetectedPreferences] Error fetching profile:', err);
        setError('Failed to load AI-detected preferences');
      } finally {
        setLoading(false);
      }
    };

    fetchEnrichedProfile();
  }, [userId]);

  // Toggle category expansion
  const toggleCategory = (category: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  // Start editing a field
  const startEditing = (fieldName: string, currentValue: string) => {
    setEditingField(fieldName);
    setEditValue(currentValue);
  };

  // Cancel editing
  const cancelEditing = () => {
    setEditingField(null);
    setEditValue('');
  };

  // Save edited field
  const saveField = async (fieldName: string) => {
    if (!enrichedProfile?.preferences) return;
    
    setSaving(true);
    try {
      const gcpBackend = config.gcpBackendClient;
      if (!gcpBackend) return;

      const updatedPreferences = {
        ...enrichedProfile.preferences,
        [fieldName]: editValue,
      };

      // Update field source to 'user_edited'
      const updatedSources = {
        ...enrichedProfile.field_sources,
        [`preferences.${fieldName}`]: 'user_edited',
      };

      const { error: updateError } = await gcpBackend
        .from('user_enriched_profiles')
        .update({
          preferences: updatedPreferences,
          field_sources: updatedSources,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);

      if (updateError) throw updateError;

      // Update local state
      setEnrichedProfile({
        ...enrichedProfile,
        preferences: updatedPreferences,
        field_sources: updatedSources,
      });

      setEditingField(null);
      setEditValue('');

      // Notify parent
      onSave?.(updatedPreferences);
    } catch (err) {
      console.error('[AIDetectedPreferences] Error saving field:', err);
    } finally {
      setSaving(false);
    }
  };

  // Get preferences for a category
  const getCategoryPreferences = (fields: string[]): [string, string][] => {
    if (!enrichedProfile?.preferences) return [];
    
    return fields
      .filter(field => {
        const value = enrichedProfile.preferences?.[field as keyof ProfilePreferences];
        return value && value !== 'Unknown' && value !== 'Not publicly available';
      })
      .map(field => [
        field,
        enrichedProfile.preferences?.[field as keyof ProfilePreferences] as string,
      ]);
  };

  // Render confidence badge
  const renderConfidenceBadge = () => {
    if (!enrichedProfile) return null;
    
    const confidence = enrichedProfile.confidence;
    const color = confidence >= 0.7 ? 'green' : confidence >= 0.4 ? 'yellow' : 'gray';
    const label = confidence >= 0.7 ? 'High' : confidence >= 0.4 ? 'Medium' : 'Low';
    
    return (
      <span 
        className={`px-2 py-0.5 text-xs font-medium rounded-full ${
          color === 'green' ? 'bg-green-100 text-green-700' :
          color === 'yellow' ? 'bg-yellow-100 text-yellow-700' :
          'bg-gray-100 text-gray-600'
        }`}
      >
        {Math.round(confidence * 100)}% {label} Confidence
      </span>
    );
  };

  // Loading state
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm">
        <div className="flex items-center gap-3 mb-4">
          <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
          <span className="text-sm text-gray-600">Loading AI-detected preferences...</span>
        </div>
      </div>
    );
  }

  // No profile data
  if (!enrichedProfile || !enrichedProfile.preferences) {
    return (
      <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl border border-blue-100 p-5 shadow-sm">
        <div className="flex items-center gap-3 mb-3">
          <div className="p-2 bg-blue-100 rounded-lg">
            <Sparkles className="w-5 h-5 text-blue-600" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900">AI-Powered Profile Intelligence</h3>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          Sign in with Google or Apple to automatically detect your preferences from the web. 
          Our AI analyzes public information to pre-fill your profile.
        </p>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Sparkles className="w-3 h-3" />
          <span>30+ preference categories detected automatically</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="bg-red-50 rounded-2xl border border-red-100 p-5">
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  // Count total preferences
  const totalPreferences = Object.values(enrichedProfile.preferences).filter(v => 
    v && v !== 'Unknown' && v !== 'Not publicly available'
  ).length;

  return (
    <section
      className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm"
      aria-labelledby="ai-detected-preferences-title"
      aria-describedby="ai-detected-preferences-description"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl shadow-lg shadow-blue-500/20">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3
              id="ai-detected-preferences-title"
              className="text-lg font-semibold text-gray-900"
            >
              AI-Detected Preferences
            </h3>
            <p className="text-xs text-gray-500">{totalPreferences} preferences detected</p>
          </div>
        </div>
        {renderConfidenceBadge()}
      </div>

      {/* Description */}
      <p
        id="ai-detected-preferences-description"
        className="text-sm text-gray-600 mb-4 px-1"
      >
        These preferences were detected using AI-powered web intelligence. 
        You can edit any field before saving to your profile.
      </p>

      {/* Categories */}
      <div className="space-y-2">
        {Object.entries(preferenceCategories).map(([category, fields]) => {
          const categoryPrefs = getCategoryPreferences(fields);
          if (categoryPrefs.length === 0) return null;

          const isExpanded = expandedCategories.has(category);
          const categoryId = toCategoryId(category);
          const triggerId = `ai-preferences-${categoryId}-trigger`;
          const panelId = `ai-preferences-${categoryId}-panel`;

          return (
            <section
              key={category}
              className="border border-gray-100 rounded-xl overflow-hidden"
              aria-labelledby={triggerId}
            >
              {/* Category Header */}
              <button
                id={triggerId}
                type="button"
                onClick={() => toggleCategory(category)}
                aria-expanded={isExpanded}
                aria-controls={panelId}
                className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-800">{category}</span>
                  <span className="text-xs text-gray-400">({categoryPrefs.length})</span>
                </div>
                {isExpanded ? (
                  <ChevronUp className="w-4 h-4 text-gray-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                )}
              </button>

              {/* Category Content */}
              {isExpanded && (
                <div
                  id={panelId}
                  className="p-3 space-y-2 bg-white"
                >
                  {categoryPrefs.map(([fieldName, value]) => {
                    const label = (PREFERENCE_FIELD_LABELS as Record<string, string>)[fieldName] || fieldName;
                    const icon = categoryIcons[fieldName] || <Heart className="w-4 h-4" />;
                    const isEditing = editingField === fieldName;
                    const isAIDetected = enrichedProfile.field_sources?.[`preferences.${fieldName}`] !== 'user_edited';

                    return (
                      <div 
                        key={fieldName}
                        className="flex items-start gap-3 p-2 rounded-lg hover:bg-gray-50 group"
                      >
                        <span className="text-blue-500 mt-0.5">{icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-xs font-medium text-gray-500">{label}</span>
                            {isAIDetected && (
                              <span className="px-1.5 py-0.5 text-[10px] bg-blue-50 text-blue-600 rounded">
                                AI
                              </span>
                            )}
                          </div>
                          
                          {isEditing ? (
                            <div className="flex items-center gap-2 mt-1">
                              <input
                                type="text"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                className="flex-1 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                                autoFocus
                              />
                              <button
                                onClick={() => saveField(fieldName)}
                                disabled={saving}
                                className="p-1 text-green-600 hover:bg-green-50 rounded"
                                aria-label={`Save ${label}`}
                              >
                                {saving ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Check className="w-4 h-4" />
                                )}
                              </button>
                              <button
                                onClick={cancelEditing}
                                className="p-1 text-gray-400 hover:bg-gray-100 rounded"
                                aria-label={`Cancel editing ${label}`}
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <p className="text-sm text-gray-800 truncate">{value}</p>
                              <button
                                onClick={() => startEditing(fieldName, value)}
                                className="p-1 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                                aria-label={`Edit ${label}`}
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* Footer */}
      <div className="mt-4 pt-3 border-t border-gray-100">
        <p className="text-xs text-gray-400 text-center">
          Last updated: {enrichedProfile.updated_at 
            ? new Date(enrichedProfile.updated_at).toLocaleDateString() 
            : 'Never'
          }
        </p>
      </div>
    </section>
  );
};

export default AIDetectedPreferences;
